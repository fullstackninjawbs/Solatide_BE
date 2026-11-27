/**
 * Visitor panel (Milestone 3): everything the four tabs show for one visit, in one read.
 *   - the visit itself (live card + full cart + its checkout attempt)
 *   - the visitor: first / last seen, number of visits, known name, first visit's source
 *   - the visitor's other visits (newest first, paged)
 *   - orders placed across all of the visitor's visits
 *
 * Linking rule: visits belong together ONLY when they share the visitor ID (same browser storage).
 * Different browsers / devices / private windows are never merged, even with the same name.
 */
import { AnalyticsSession, AnalyticsVisitor, CheckoutSession } from '../../../models/analyticsSession.model';
import Order from '../../../models/order.model';
import Customer from '../../../models/Customer';
import { CHECKOUT_ABANDON_MS } from '../config';
import { visitorCard, visitorSummary, anonymousId, iso } from './cards';
import { withVisitorIdentity } from './identity';

export const OTHER_VISITS_PAGE_SIZE = 10;
const MAX_ORDERS = 50;

const SESSION_FIELDS =
  'sessionId visitorId startedAt lastActivityAt leftAt isNewVisitor landingPage source device geo counts lastEvent cart checkout identity orderIds requestNumbers';
const ROW_FIELDS = 'sessionId visitorId startedAt lastActivityAt landingPage source device geo counts cart checkout orderIds requestNumbers';

export type VisitOutcome = 'ordered' | 'requested' | 'checkout' | 'cart' | 'browsed';

/** How far a visit got: placed an order > sent an order request > started checkout > added to cart > only browsed. */
export function visitOutcome(s: any): VisitOutcome {
  if (Array.isArray(s?.orderIds) && s.orderIds.length) return 'ordered';
  if (Array.isArray(s?.requestNumbers) && s.requestNumbers.length) return 'requested';
  if (s?.checkout?.checkoutId || s?.checkout?.stage) return 'checkout';
  if ((s?.counts?.addToCart || 0) > 0 || (s?.cart?.itemCount || 0) > 0) return 'cart';
  return 'browsed';
}

const seconds = (from: unknown, to: unknown): number =>
  from && to ? Math.max(0, Math.round((new Date(to as any).getTime() - new Date(from as any).getTime()) / 1000)) : 0;

/** One row of the "Previous sessions" list. */
export function visitRow(s: any, orderNumbers: Map<string, string | undefined>, latestSessionId?: string) {
  const summary = visitorSummary(s);
  return {
    sessionId: s.sessionId,
    startedAt: iso(s.startedAt),
    lastActivityAt: iso(s.lastActivityAt),
    durationSeconds: seconds(s.startedAt, s.lastActivityAt),
    landingPage: s.landingPage || undefined,
    source: summary.source,
    device: summary.device,
    location: summary.location,
    counts: {
      pageViews: s.counts?.pageViews || 0,
      productViews: s.counts?.productViews || 0,
      addToCart: s.counts?.addToCart || 0,
    },
    cart: s.cart?.itemCount ? { itemCount: s.cart.itemCount, value: s.cart.value || 0 } : null,
    checkoutStage: s.checkout?.stage || undefined,
    orders: (Array.isArray(s.orderIds) ? s.orderIds : []).map((id: any) => ({ id: String(id), orderNumber: orderNumbers.get(String(id)) })),
    requestNumbers: Array.isArray(s.requestNumbers) ? s.requestNumbers.map(String) : [],
    outcome: visitOutcome(s),
    isLatest: !!latestSessionId && s.sessionId === latestSessionId,
  };
}

/** The visit's checkout attempt, with "abandoned" derived the same way as the reports. */
export function checkoutView(c: any, now = Date.now()) {
  if (!c) return null;
  const submitted = c.status === 'order_submitted';
  const idle = now - new Date(c.lastActivityAt).getTime();
  return {
    checkoutId: c.checkoutId,
    status: submitted ? 'order_submitted' : idle > CHECKOUT_ABANDON_MS ? 'abandoned' : 'in_progress',
    stage: c.stage || 'started',
    paymentMethod: c.paymentMethod || undefined,
    startedAt: iso(c.startedAt),
    lastActivityAt: iso(c.lastActivityAt),
    errorCount: c.errorCount || 0,
    lastError: c.lastError || undefined,
    orderId: c.orderId ? String(c.orderId) : undefined,
    requestNumber: c.requestNumber || undefined,
  };
}

export function orderView(o: any) {
  const total = typeof o.grandTotal === 'number' ? o.grandTotal : typeof o.totalAmount === 'number' ? o.totalAmount : undefined;
  return {
    id: String(o._id),
    orderNumber: o.orderNumber ? String(o.orderNumber) : undefined,
    total,
    currency: o.currency || 'AUD',
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod || undefined,
    refundedAmount: o.refundedAmount || 0,
    createdAt: iso(o.createdAt),
  };
}

/** Null when the visit doesn't exist. `page` pages the visitor's other visits (1-based). */
export async function buildVisitorProfile(sessionId: string, page = 1, now = Date.now()) {
  const found: any = await AnalyticsSession.findOne({ sessionId }).select(SESSION_FIELDS).lean();
  if (!found) return null;
  const [session] = await withVisitorIdentity([found]);
  const visitorId: string = session.visitorId;
  const sameVisitor = { visitorId };
  const others = { visitorId, sessionId: { $ne: sessionId } };
  const skip = (Math.max(1, page) - 1) * OTHER_VISITS_PAGE_SIZE;

  const [visitor, otherRows, otherTotal, firstVisit, latest, withOrders, checkout]: any[] = await Promise.all([
    AnalyticsVisitor.findOne(sameVisitor).select('visitorId firstSeenAt lastSeenAt sessionCount identity').lean(),
    AnalyticsSession.find(others).sort({ startedAt: -1 }).skip(skip).limit(OTHER_VISITS_PAGE_SIZE + 1).select(ROW_FIELDS).lean(),
    AnalyticsSession.countDocuments(others),
    AnalyticsSession.findOne(sameVisitor).sort({ startedAt: 1 }).select('sessionId startedAt source landingPage').lean(),
    AnalyticsSession.findOne(sameVisitor).sort({ startedAt: -1 }).select('sessionId').lean(),
    AnalyticsSession.find({ ...sameVisitor, 'orderIds.0': { $exists: true } }).sort({ startedAt: -1 }).limit(200).select('orderIds').lean(),
    session.checkout?.checkoutId ? CheckoutSession.findOne({ checkoutId: session.checkout.checkoutId }).lean() : null,
  ]);

  const hasMore = otherRows.length > OTHER_VISITS_PAGE_SIZE;
  const pageRows = otherRows.slice(0, OTHER_VISITS_PAGE_SIZE);

  const orderIds = new Set<string>();
  for (const s of [...withOrders, ...pageRows, session]) for (const id of s.orderIds || []) orderIds.add(String(id));
  const orders: any[] = orderIds.size
    ? await Order.find({ _id: { $in: [...orderIds] } })
        .sort({ createdAt: -1 })
        .limit(MAX_ORDERS * 2)
        .select('orderNumber grandTotal totalAmount currency status paymentStatus paymentMethod refundedAmount createdAt')
        .lean()
    : [];
  const orderNumbers = new Map(orders.map((o) => [String(o._id), o.orderNumber ? String(o.orderNumber) : undefined]));

  const visitorOrderIds = new Set<string>();
  for (const s of [...withOrders, session]) for (const id of s.orderIds || []) visitorOrderIds.add(String(id));

  // Earliest of the profile's first-seen and the oldest visit on record
  const firstSeenCandidates = [visitor?.firstSeenAt, firstVisit?.startedAt].filter(Boolean).map((d: any) => new Date(d).getTime());
  const lastSeenCandidates = [visitor?.lastSeenAt, session.lastActivityAt].filter(Boolean).map((d: any) => new Date(d).getTime());

  const ownIdentity = found.identity && (found.identity.name || found.identity.email) ? found.identity : null;
  const knownIdentity = ownIdentity || session.identity || visitor?.identity || null;
  // Customer record link: only for an identity the visitor gave in a checkout, order or order link
  // (never guessed), matched by that exact email
  const knownEmail = typeof knownIdentity?.email === 'string' ? knownIdentity.email.trim().toLowerCase() : '';
  const customer: any = knownEmail ? await Customer.findOne({ email: knownEmail }).select('_id').lean().catch(() => null) : null;

  // How this visit arrived: referrer site, UTM tags and ad click type, exactly as recorded
  const src: any = found.source || {};
  const utm = Object.fromEntries(Object.entries(src.utm || {}).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));

  return {
    serverTime: new Date(now).toISOString(),
    session: { ...visitorCard(session, now), checkout: checkoutView(checkout, now) },
    visit: {
      sessionId: found.sessionId,
      referrerDomain: src.referrerDomain || undefined,
      utm: Object.keys(utm).length ? utm : undefined,
      clickId: src.clickId || undefined,
    },
    visitor: {
      visitorId,
      anonymousId: anonymousId(visitorId),
      firstSeenAt: firstSeenCandidates.length ? new Date(Math.min(...firstSeenCandidates)).toISOString() : iso(session.startedAt),
      lastSeenAt: lastSeenCandidates.length ? new Date(Math.max(...lastSeenCandidates)).toISOString() : iso(session.lastActivityAt),
      visitCount: otherTotal + 1,
      identity: knownIdentity && (knownIdentity.name || knownIdentity.email)
        ? {
          name: knownIdentity.name || undefined,
          email: knownIdentity.email || undefined,
          from: ownIdentity ? 'this_visit' : 'earlier_visit',
          customerId: customer?._id ? String(customer._id) : undefined,
        }
        : null,
      firstVisit: firstVisit
        ? { sessionId: firstVisit.sessionId, startedAt: iso(firstVisit.startedAt), landingPage: firstVisit.landingPage || undefined, source: visitorSummary(firstVisit).source }
        : null,
      latestSessionId: latest?.sessionId,
    },
    orders: orders.filter((o) => visitorOrderIds.has(String(o._id))).slice(0, MAX_ORDERS).map(orderView),
    otherVisits: {
      items: pageRows.map((s: any) => visitRow(s, orderNumbers, latest?.sessionId)),
      page: Math.max(1, page),
      hasMore,
      total: otherTotal,
    },
  };
}
