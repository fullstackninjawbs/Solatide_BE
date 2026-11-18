/**
 * Builds and announces live updates after tracking data was stored:
 *   { type: 'update', session: VisitorCard | null, activity: ActivityItem[], serverTime }
 * - storefront batches (collect.ts): the session's new card + its newly stored events. A heartbeat
 *   sends only the card (fresh lastActivityAt / leftAt), which keeps "active now" accurate.
 * - order events (serverEvents.ts): the order event + the linked session's card.
 * Skipped while nobody watches; never throws (tracking and orders must not be affected).
 */
import { AnalyticsSession } from '../../../models/analyticsSession.model';
import { publish, anyViewers } from './bus';
import { visitorCard, activityItem } from './cards';

const SESSION_FIELDS =
  'sessionId visitorId startedAt lastActivityAt leftAt isNewVisitor landingPage source device geo counts lastEvent cart checkout identity orderIds';

export async function publishSessionUpdate(sessionId: string, events: any[] = [], extra: { orderNumber?: string } = {}): Promise<void> {
  try {
    if (!(await anyViewers())) return;
    const session: any = sessionId ? await AnalyticsSession.findOne({ sessionId }).select(SESSION_FIELDS).lean() : null;
    const card = session ? visitorCard(session) : null;
    const summary = card
      ? (({ sessionId: sid, visitorId, name, anonymousId, identified, location, device, source, isNewVisitor }) =>
          ({ sessionId: sid, visitorId, name, anonymousId, identified, location, device, source, isNewVisitor }))(card)
      : null;
    if (!card && !events.length) return;
    await publish({
      type: 'update',
      serverTime: new Date().toISOString(),
      session: card,
      activity: events.map((e) => activityItem(e, summary, extra)),
    });
  } catch (err: any) {
    console.error(`[Analytics] live update failed: ${err?.message}`);
  }
}
