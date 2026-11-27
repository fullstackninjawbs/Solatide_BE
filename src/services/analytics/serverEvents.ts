/**
 * Order events recorded by the server (trusted, never sent by the browser), linked to the
 * visitor's session and checkout attempt sent with the checkout (order.visitor):
 *   order_placed     the order was submitted (a bank transfer is then still unpaid)
 *   purchase         payment confirmed (onOrderPaid), timestamp = paidAt
 *   order_cancelled / order_refunded   (paymentTransition)
 *   order_request    an order request was sent (Order Request checkout; see recordOrderRequestEvent)
 *
 * Each event's id is derived from the order ("order_placed:<orderId>"), so a retry or a second
 * webhook never records it twice. Failures are logged and never break the order flow.
 */
import AnalyticsEvent from '../../models/analyticsEvent.model';
import { AnalyticsSession, AnalyticsVisitor, CheckoutSession } from '../../models/analyticsSession.model';
import { SESSION_TIMEOUT_MS } from './config';
import { publishSessionUpdate } from './live/publish';

type OrderEventType = 'order_placed' | 'purchase' | 'order_cancelled' | 'order_refunded';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const validId = (v: unknown): string | undefined => (typeof v === 'string' && ID_RE.test(v) ? v : undefined);

const orderTotal = (order: any): number => Number(order.grandTotal ?? order.totalAmount ?? 0) || 0;

/** Records one order event. Returns false when it was already recorded (or could not be). */
export async function recordOrderEvent(
  order: any,
  type: OrderEventType,
  opts: { at?: Date; eventKey?: string; value?: number } = {}
): Promise<boolean> {
  try {
    const sessionId = validId(order.visitor?.sessionId);
    const visitorId = validId(order.visitor?.visitorId);
    const checkoutId = validId(order.visitor?.checkoutId);
    const session: any = sessionId ? await AnalyticsSession.findOne({ sessionId }).select('geo visitorId').lean() : null;
    // Location of the visitor (session IP lookup, else what the storefront sent) — never the address
    const known = (c: unknown) => typeof c === 'string' && c.trim() !== '' && c !== 'Unknown';
    const loc = known(session?.geo?.country)
      ? { country: session.geo.country, region: session.geo.region, city: session.geo.city }
      : known(order.visitor?.country) ? { country: order.visitor.country, region: order.visitor.region, city: order.visitor.city } : null;

    const created = await AnalyticsEvent.create({
      eventId: `${type}:${order._id}${opts.eventKey ? `:${opts.eventKey}` : ''}`,
      sessionId: sessionId || order.attribution?.lastTouch?.sessionId || order.attribution?.firstTouch?.sessionId || `order:${order._id}`,
      visitorId: visitorId || session?.visitorId,
      checkoutId,
      eventType: type,
      orderId: order._id,
      cartValue: opts.value ?? orderTotal(order),
      page: `/order/${order._id}`,
      path: `/order/${order._id}`,
      clientReported: false,
      timestamp: opts.at ?? new Date(),
      ...(loc ? { country: loc.country, region: loc.region || undefined, city: loc.city || undefined } : {}),
    });

    const at = opts.at ?? new Date();
    if (type === 'order_placed') await linkPlacedOrder(order, { sessionId, visitorId, checkoutId }, at);
    else if (sessionId) {
      // Paid / cancelled / refunded while the visit is still open (e.g. a card payment straight after
      // checkout) becomes the card's latest action. A bank transfer paid days later does not touch
      // the old visit. Never counts as visitor activity (lastActivityAt unchanged).
      await AnalyticsSession.updateOne(
        { sessionId, lastActivityAt: { $gte: new Date(Date.now() - SESSION_TIMEOUT_MS) } },
        { $set: { lastEvent: { type, path: `/order/${order._id}`, value: opts.value ?? orderTotal(order), orderId: order._id, at } } }
      );
    }
    void publishSessionUpdate(sessionId || '', [created.toObject()], { orderNumber: order.orderNumber ? String(order.orderNumber) : undefined });
    return true;
  } catch (err: any) {
    if (err?.code === 11000) return false; // already recorded
    console.error(`[Analytics] ${type} event for order ${order?._id} failed: ${err?.message}`);
    return false;
  }
}

/** Marks the checkout attempt as submitted and links the order + customer to the session/visitor. */
async function linkPlacedOrder(order: any, ids: { sessionId?: string; visitorId?: string; checkoutId?: string }, at: Date) {
  const email = String(order.customer?.email || order.customerEmail || '').trim().toLowerCase() || undefined;
  const name = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || order.customerName || undefined;
  const identity: Record<string, unknown> = {};
  if (email) identity['identity.email'] = email;
  if (name) identity['identity.name'] = name;
  if (order.user) identity['identity.customerId'] = String(order.user);

  if (ids.checkoutId) {
    await CheckoutSession.updateOne(
      { checkoutId: ids.checkoutId, ...(ids.visitorId ? { visitorId: ids.visitorId } : {}) },
      {
        $set: {
          status: 'order_submitted', orderId: order._id, orderSubmittedAt: at, lastActivityAt: at, stage: 'payment',
          'stageAt.payment': at,
          ...(order.paymentMethod ? { paymentMethod: order.paymentMethod } : {}),
          ...(email ? { 'contact.email': email } : {}),
          ...(order.customer?.firstName ? { 'contact.firstName': order.customer.firstName } : {}),
          ...(order.customer?.lastName ? { 'contact.lastName': order.customer.lastName } : {}),
        },
      }
    );
  }
  if (ids.sessionId) {
    await AnalyticsSession.updateOne(
      { sessionId: ids.sessionId },
      {
        $addToSet: { orderIds: order._id },
        $set: {
          ...identity,
          lastActivityAt: at,
          lastEvent: { type: 'order_placed', path: '/checkout', value: orderTotal(order), orderId: order._id, at },
          // The cart was turned into this order
          cart: { items: [], itemCount: 0, value: 0, updatedAt: at },
        },
      }
    );
  }
  if (ids.visitorId && Object.keys(identity).length) {
    await AnalyticsVisitor.updateOne({ visitorId: ids.visitorId }, { $set: identity });
  }
}

/**
 * Order Request checkout: the customer sent an order request (no order exists yet; the admin creates
 * it later from Admin → Order requests). Recorded once per request ("order_request:<requestId>"):
 *   - the checkout attempt is closed as submitted, so it is never counted as abandoned;
 *   - the visit gets the customer's name/email (typed in this checkout), "Order request sent" as its
 *     latest action, the request reference, and an emptied cart (the cart became the request);
 *   - the visitor profile gets the name/email.
 * Best effort: failures are logged and never affect the request.
 */
export async function recordOrderRequestEvent(request: any, opts: { at?: Date } = {}): Promise<boolean> {
  try {
    const sessionId = validId(request?.visitor?.sessionId);
    if (!request?._id || !sessionId) return false; // no visit to link (tracking blocked, old storefront)
    const visitorId = validId(request.visitor?.visitorId);
    const checkoutId = validId(request.visitor?.checkoutId);
    const at = opts.at ?? new Date();
    const value = Number(request.total ?? request.subtotal ?? 0) || 0;
    const requestNumber = request.requestNumber ? String(request.requestNumber) : undefined;

    const session: any = await AnalyticsSession.findOne({ sessionId }).select('geo visitorId').lean();
    // A visit belongs to one visitor: never link a request to a visit owned by someone else
    if (session && visitorId && session.visitorId && session.visitorId !== visitorId) return false;
    const known = (c: unknown) => typeof c === 'string' && c.trim() !== '' && c !== 'Unknown';
    const loc = known(session?.geo?.country) ? { country: session.geo.country, region: session.geo.region, city: session.geo.city } : null;

    const created = await AnalyticsEvent.create({
      eventId: `order_request:${request._id}`,
      sessionId,
      visitorId: visitorId || session?.visitorId,
      checkoutId,
      eventType: 'order_request',
      requestNumber,
      cartValue: value,
      page: '/checkout',
      path: '/checkout',
      clientReported: false,
      timestamp: at,
      ...(loc ? { country: loc.country, region: loc.region || undefined, city: loc.city || undefined } : {}),
    });

    const email = String(request.customer?.email || '').trim().toLowerCase() || undefined;
    const name = [request.customer?.firstName, request.customer?.lastName].filter(Boolean).join(' ').trim() || undefined;
    const identity: Record<string, unknown> = {};
    if (email) identity['identity.email'] = email;
    if (name) identity['identity.name'] = name;

    if (checkoutId) try {
      const owner = { checkoutId, ...(visitorId ? { visitorId } : {}) };
      // Upsert: a request sent within a second of opening checkout can arrive before the browser's
      // first checkout event. Creating the attempt here as submitted means those late events are
      // ignored (collect.ts skips submitted attempts) instead of reopening it as "in progress".
      await CheckoutSession.updateOne(owner, {
        ...(visitorId ? { $setOnInsert: { sessionId, startedAt: at } } : {}),
        $set: {
          status: 'order_submitted', orderRequestId: request._id, orderSubmittedAt: at, lastActivityAt: at,
          paymentMethod: 'order_request',
          ...(requestNumber ? { requestNumber } : {}),
          ...(email ? { 'contact.email': email } : {}),
          ...(request.customer?.firstName ? { 'contact.firstName': request.customer.firstName } : {}),
          ...(request.customer?.lastName ? { 'contact.lastName': request.customer.lastName } : {}),
          ...(request.shippingAddress?.country ? { 'contact.country': request.shippingAddress.country } : {}),
        },
      }, { upsert: !!visitorId });
      // The server accepted contact details + address, so the attempt reached at least Shipping
      await CheckoutSession.updateOne(
        { ...owner, $or: [{ stage: { $in: ['started', 'information'] } }, { stage: { $exists: false } }] },
        { $set: { stage: 'shipping', 'stageAt.shipping': at } }
      );
    } catch (err: any) {
      // e.g. the attempt id belongs to another visitor (duplicate key on upsert): leave it alone
      console.error(`[Analytics] order_request: checkout attempt ${checkoutId} not updated: ${err?.message}`);
    }
    await AnalyticsSession.updateOne(
      { sessionId },
      {
        ...(requestNumber ? { $addToSet: { requestNumbers: requestNumber } } : {}),
        $set: {
          ...identity,
          lastActivityAt: at,
          lastEvent: { type: 'order_request', path: '/checkout', value, requestNumber, at },
          // The order request form ends at Shipping (no payment step: details are emailed later)
          ...(checkoutId ? { 'checkout.checkoutId': checkoutId, 'checkout.stage': 'shipping' } : {}),
          cart: { items: [], itemCount: 0, value: 0, updatedAt: at },
        },
      }
    );
    const owner = visitorId || session?.visitorId;
    if (owner && Object.keys(identity).length) await AnalyticsVisitor.updateOne({ visitorId: owner }, { $set: identity });

    void publishSessionUpdate(sessionId, [created.toObject()]);
    return true;
  } catch (err: any) {
    if (err?.code === 11000) return false; // already recorded
    console.error(`[Analytics] order_request event for request ${request?._id} failed: ${err?.message}`);
    return false;
  }
}

/**
 * The admin created an order from an order request: the order joins the visit that sent the request
 * (shown under that visit's orders, and its payment confirmation is recorded in that visit, because
 * the order carries the request's visitor IDs). No second "order placed" is recorded: the customer
 * submitted once (the order_request event). Best effort; never throws.
 */
export async function linkOrderToRequestVisit(order: any, request: any): Promise<void> {
  try {
    const sessionId = validId(request?.visitor?.sessionId);
    const checkoutId = validId(request?.visitor?.checkoutId);
    if (!order?._id || !sessionId) return;
    await AnalyticsSession.updateOne({ sessionId }, { $addToSet: { orderIds: order._id } });
    if (checkoutId) await CheckoutSession.updateOne({ checkoutId, orderRequestId: request._id }, { $set: { orderId: order._id } });
    void publishSessionUpdate(sessionId);
  } catch (err: any) {
    console.error(`[Analytics] linking order ${order?._id} to its request's visit failed: ${err?.message}`);
  }
}

/** The visitor IDs an order created from a request should carry (only well-formed IDs). */
export function visitorFromRequest(request: any): { sessionId?: string; visitorId?: string; checkoutId?: string; country?: string } | undefined {
  const sessionId = validId(request?.visitor?.sessionId);
  if (!sessionId) return undefined;
  return {
    sessionId,
    visitorId: validId(request.visitor?.visitorId),
    checkoutId: validId(request.visitor?.checkoutId),
    country: typeof request.visitor?.country === 'string' ? request.visitor.country.slice(0, 100) : undefined,
  };
}

/**
 * A visit opened an order's own payment link (/checkout/payment/:id with its secret access token),
 * e.g. from the payment-details email in another browser, or "Open in Chrome" from the Google app.
 * Each browser has its own visitor ID, so that visit was an anonymous new visitor. The valid token
 * proves which order it is, so the order's customer name/email is put on that visit and its visitor
 * profile: an order link, not a guess (visitors are still never merged).
 *
 * - The order is NOT added to the visit's orders (it was placed in the other visit; counting it
 *   again would double-count orders).
 * - A visit or visitor that already has its own identity is left as it is.
 * - The visit may not be stored yet when the payment page loads (events are sent ~1 s later), so a
 *   missing visit is retried a few seconds later. Best effort; never throws.
 */
const LINK_RETRY_MS = [3000, 10000];

export async function linkVisitByOrderAccess(order: any, raw: { sessionId?: unknown; visitorId?: unknown }, attempt = 0): Promise<void> {
  try {
    const sessionId = validId(raw.sessionId);
    const visitorId = validId(raw.visitorId);
    if (!order || (!sessionId && !visitorId)) return;
    // The browser that placed the order is already linked by the checkout
    if (sessionId && sessionId === order.visitor?.sessionId) return;

    const email = String(order.customer?.email || order.customerEmail || '').trim().toLowerCase() || undefined;
    const name = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || order.customerName || undefined;
    if (!email && !name) return;
    const identity: Record<string, unknown> = { 'identity.linkedBy': 'order_link', 'identity.linkedOrderId': order._id };
    if (email) identity['identity.email'] = email;
    if (name) identity['identity.name'] = name;
    const noIdentity = { 'identity.name': { $in: [null, ''] }, 'identity.email': { $in: [null, ''] } };

    let sessionFound = !sessionId;
    if (sessionId) {
      const res = await AnalyticsSession.updateOne({ sessionId, ...noIdentity }, { $set: identity });
      sessionFound = res.matchedCount > 0 || !!(await AnalyticsSession.exists({ sessionId }));
      if (res.modifiedCount > 0) void publishSessionUpdate(sessionId);
    }
    if (visitorId) {
      await AnalyticsVisitor.updateOne({ visitorId, ...noIdentity }, { $set: identity });
    }
    if (!sessionFound && attempt < LINK_RETRY_MS.length) {
      setTimeout(() => { void linkVisitByOrderAccess(order, raw, attempt + 1); }, LINK_RETRY_MS[attempt]).unref?.();
    }
  } catch (err: any) {
    console.error(`[Analytics] linking a visit to order ${order?._id} by its payment link failed: ${err?.message}`);
  }
}
