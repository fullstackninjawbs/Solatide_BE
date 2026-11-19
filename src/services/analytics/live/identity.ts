/**
 * Known visitor names on every visit of the same browser.
 *
 * A name (or email) is saved on the visit where it was typed in at checkout or linked by an order,
 * and on that visitor's profile (AnalyticsVisitor). Later or earlier visits from the SAME visitor ID
 * (same browser storage) have no name of their own, so the admin saw an anonymous #ID for a customer
 * who is already known. This fills in the profile's name for those visits, at read time only.
 *
 * Matching is by visitor ID only: different browsers / devices / private windows have different
 * visitor IDs and are never merged. A visit's own identity always wins over the profile's.
 */
import { AnalyticsVisitor } from '../../../models/analyticsSession.model';

type Identity = { name?: string; email?: string; customerId?: string; source?: 'visit' | 'visitor' };
type WithIdentity = { visitorId?: string; identity?: Identity | null };

const hasName = (i: Identity | null | undefined): boolean => !!(i && (i.name || i.email));

/** Returns the sessions with identity filled in from the visitor profile where the visit has none. */
export async function withVisitorIdentity<T extends WithIdentity>(sessions: T[]): Promise<T[]> {
  const need = [...new Set(sessions.filter((s) => s?.visitorId && !hasName(s.identity)).map((s) => s.visitorId as string))];
  if (!need.length) return sessions;
  const visitors: any[] = await AnalyticsVisitor.find({
    visitorId: { $in: need },
    $or: [{ 'identity.name': { $type: 'string', $ne: '' } }, { 'identity.email': { $type: 'string', $ne: '' } }],
  })
    .select('visitorId identity')
    .lean();
  if (!visitors.length) return sessions;
  const byVisitor = new Map(visitors.map((v) => [v.visitorId, v.identity as Identity]));
  return sessions.map((s) => {
    if (hasName(s.identity) || !s.visitorId) return s;
    const known = byVisitor.get(s.visitorId);
    if (!known) return s;
    return {
      ...s,
      identity: {
        ...(s.identity || {}),
        name: known.name || undefined,
        email: known.email || undefined,
        customerId: known.customerId || undefined,
        source: 'visitor',
      },
    };
  });
}

/** Visitor IDs whose profile name/email matches the search (so "Aditya" also finds their anonymous visits). */
export async function visitorIdsMatching(re: RegExp, limit = 200): Promise<string[]> {
  const rows: any[] = await AnalyticsVisitor.find({ $or: [{ 'identity.name': re }, { 'identity.email': re }] })
    .limit(limit)
    .select('visitorId')
    .lean();
  return rows.map((r) => r.visitorId).filter(Boolean);
}
