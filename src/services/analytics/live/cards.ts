/**
 * What the admin live views show for a visit and for one recorded action. The visitor cards, the
 * "All activity" feed and the live stream all use these, so a visitor looks the same everywhere.
 *
 * Identity: a name (or email) only when the visitor typed it in checkout or an order linked it;
 * otherwise a short anonymous ID derived from the visitor ID. Visitors are never merged.
 */
import { liveStatus, ACTIVE_WINDOW_SECONDS, SESSION_TIMEOUT_MINUTES } from '../config';

// Country names the storefront's timezone fallback sends (no ISO code) → code, for the flag
const COUNTRY_CODES: Record<string, string> = {
  Australia: 'AU', 'New Zealand': 'NZ', 'United Kingdom': 'GB', 'United States': 'US', Canada: 'CA',
  Singapore: 'SG', India: 'IN',
};

export const anonymousId = (visitorId: string | undefined): string =>
  visitorId ? `#${visitorId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}` : '#UNKNOWN';

export interface VisitorSummary {
  sessionId: string;
  visitorId?: string;
  name?: string;
  anonymousId: string;
  identified: boolean;
  location: { country?: string; countryCode?: string; region?: string; city?: string; method?: string } | null;
  device: { type?: string; label?: string; os?: string; browser?: string } | null;
  source: { source?: string; channel?: string; campaign?: string; referrerDomain?: string } | null;
  isNewVisitor: boolean | null;
}

export interface VisitorCard extends VisitorSummary {
  startedAt?: string;
  lastActivityAt?: string;
  leftAt?: string;
  status: 'active' | 'inactive' | 'ended';
  landingPage?: string;
  lastEvent: Record<string, unknown> | null;
  counts: Record<string, number>;
  cart: { itemCount: number; value: number } | null;
  checkoutStage?: string;
  orderCount: number;
}

const iso = (d: unknown): string | undefined => (d ? new Date(d as any).toISOString() : undefined);

export function visitorSummary(s: any): VisitorSummary {
  const name = s?.identity?.name || s?.identity?.email || undefined;
  const geo = s?.geo;
  const country = geo?.country && geo.country !== 'Unknown' ? geo.country : undefined;
  return {
    sessionId: s.sessionId,
    visitorId: s.visitorId,
    name,
    anonymousId: anonymousId(s.visitorId),
    identified: !!name,
    location: country
      ? { country, countryCode: geo.countryCode || COUNTRY_CODES[country] || undefined, region: geo.region || undefined, city: geo.city || undefined, method: geo.method }
      : null,
    device: s?.device?.type || s?.device?.label ? { type: s.device.type, label: s.device.label, os: s.device.os, browser: s.device.browser } : null,
    source: s?.source?.source || s?.source?.channel
      ? { source: s.source.source, channel: s.source.channel, campaign: s.source.campaign || s.source.utm?.campaign || undefined, referrerDomain: s.source.referrerDomain }
      : null,
    isNewVisitor: typeof s?.isNewVisitor === 'boolean' ? s.isNewVisitor : null,
  };
}

export function visitorCard(s: any, now = Date.now()): VisitorCard {
  const ev = s.lastEvent;
  return {
    ...visitorSummary(s),
    startedAt: iso(s.startedAt),
    lastActivityAt: iso(s.lastActivityAt),
    leftAt: iso(s.leftAt),
    status: liveStatus(s, now),
    landingPage: s.landingPage || undefined,
    lastEvent: ev?.type
      ? {
          type: ev.type, path: ev.path, productName: ev.productName, productImage: ev.productImage,
          variantTitle: ev.variantTitle, quantity: ev.quantity, stage: ev.stage, value: ev.value,
          orderId: ev.orderId ? String(ev.orderId) : undefined, at: iso(ev.at),
        }
      : null,
    counts: {
      pageViews: s.counts?.pageViews || 0,
      productViews: s.counts?.productViews || 0,
      addToCart: s.counts?.addToCart || 0,
      cartUpdates: s.counts?.cartUpdates || 0,
    },
    cart: s.cart ? { itemCount: s.cart.itemCount || 0, value: s.cart.value || 0 } : null,
    checkoutStage: s.checkout?.stage || undefined,
    orderCount: Array.isArray(s.orderIds) ? s.orderIds.length : 0,
  };
}

/** One recorded action for the feed / stream. `id` = the event's unique id (dedupe key). */
export function activityItem(e: any, visitor: VisitorSummary | null, extra: { orderNumber?: string } = {}) {
  return {
    id: e.eventId || String(e._id),
    cursor: e._id ? `${new Date(e.timestamp).getTime()}_${e._id}` : undefined,
    type: e.eventType,
    at: iso(e.timestamp),
    path: e.path || undefined,
    productName: e.productName || undefined,
    productImage: e.productImage || undefined,
    variantTitle: e.variantTitle || undefined,
    quantity: typeof e.quantity === 'number' ? e.quantity : undefined,
    stage: e.stage || undefined,
    error: e.errorMessage || undefined,
    value: typeof e.cartValue === 'number' ? e.cartValue : undefined,
    orderId: e.orderId ? String(e.orderId) : undefined,
    orderNumber: extra.orderNumber,
    sessionId: e.sessionId,
    visitor,
  };
}

/** Definitions sent with every snapshot, so the page and the server agree. */
export const liveDefinitions = () => ({
  activeWindowSeconds: ACTIVE_WINDOW_SECONDS,
  sessionTimeoutMinutes: SESSION_TIMEOUT_MINUTES,
});
