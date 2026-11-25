/**
 * Order events recorded by the server (trusted, never sent by the browser), linked to the
 * visitor's session and checkout attempt sent with the checkout (order.visitor):
 *   order_placed     the order was submitted (a bank transfer is then still unpaid)
 *   purchase         payment confirmed (onOrderPaid), timestamp = paidAt
 *   order_cancelled / order_refunded   (paymentTransition)
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
