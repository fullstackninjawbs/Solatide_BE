/**
 * Analytics definitions shared by tracking, reporting and the abandoned-checkout logic.
 *
 * - Visitor: one browser, identified by a persistent anonymous ID (localStorage). Never merged with
 *   another visitor; a name/email is attached only when the visitor enters it in checkout or an
 *   order links it.
 * - Session: one visit. A new session starts after ANALYTICS_SESSION_TIMEOUT_MINUTES without
 *   activity, or when the visitor arrives from a new campaign (UTM / ad click ID). The storefront
 *   applies the same timeout (Client/src/utils/analytics.js SESSION_TIMEOUT_MS).
 * - Abandoned checkout: a started checkout with no activity for CHECKOUT_ABANDON_MINUTES and no
 *   submitted order. Derived when reporting (not stored), so it resolves by itself when the
 *   visitor comes back or completes the order.
 */
const minutes = (v: string | undefined, fallback: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= max ? Math.floor(n) : fallback;
};

export const SESSION_TIMEOUT_MINUTES = minutes(process.env.ANALYTICS_SESSION_TIMEOUT_MINUTES, 30, 24 * 60);
export const CHECKOUT_ABANDON_MINUTES = minutes(process.env.CHECKOUT_ABANDON_MINUTES, 30, 7 * 24 * 60);

export const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_MINUTES * 60 * 1000;
export const CHECKOUT_ABANDON_MS = CHECKOUT_ABANDON_MINUTES * 60 * 1000;

/**
 * "Active now" (live visitor cards, "Visitors right now"): the visitor did something or their open,
 * visible tab sent a heartbeat within ACTIVE_WINDOW_SECONDS, and they have not left (closed or
 * hidden the tab) since. The storefront sends a heartbeat every 30 s while the visitor is using the
 * page (Client/src/utils/analytics.js PING_EVERY_MS), so 75 s tolerates one lost heartbeat.
 * Not the same as a session: a session only ends after SESSION_TIMEOUT_MINUTES of inactivity.
 */
const seconds = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};
export const ACTIVE_WINDOW_SECONDS = seconds(process.env.ANALYTICS_ACTIVE_SECONDS, 75, 30, 600);
export const ACTIVE_WINDOW_MS = ACTIVE_WINDOW_SECONDS * 1000;

/** Live status of a session at `now`: active, inactive (session still open) or ended. */
export type LiveStatus = 'active' | 'inactive' | 'ended';
export function liveStatus(s: { lastActivityAt?: Date | string; leftAt?: Date | string | null }, now = Date.now()): LiveStatus {
  const last = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
  const idle = now - last;
  if (idle > SESSION_TIMEOUT_MS) return 'ended';
  const left = s.leftAt ? new Date(s.leftAt).getTime() >= last : false;
  return !left && idle <= ACTIVE_WINDOW_MS ? 'active' : 'inactive';
}
