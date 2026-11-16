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
