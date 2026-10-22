/**
 * metaCapi.ts — pure helpers for the Meta Conversions API (no config, models or network here).
 *
 * - Customer details are normalised and SHA-256 hashed as Meta requires before they leave the
 *   server; client IP, user agent and the _fbp/_fbc cookies are sent unhashed (Meta's rules).
 * - content_id = variant SKU, else product SKU, else product id. The browser Pixel
 *   (Client/src/utils/metaPixel.js) uses the same rule so both sides describe items identically.
 * - Browser-relayed events are whitelisted and validated here; Purchase is never accepted from the
 *   browser (the server sends it from the paid-order side effects).
 */
import crypto from 'crypto';

export const META_CURRENCY = 'AUD';
/** Events the storefront may relay for CAPI. Purchase is server-only. */
export const BROWSER_RELAY_EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout'] as const;
export type BrowserRelayEvent = (typeof BROWSER_RELAY_EVENTS)[number];
/** Meta rejects events older than 7 days. */
export const MAX_EVENT_AGE_S = 7 * 24 * 3600;

export const purchaseEventId = (orderId: unknown): string => `purchase_${String(orderId)}`;

export function contentIdFor(item: { sku?: unknown; productId?: unknown }): string {
  const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
  return sku || String(item.productId ?? '').trim();
}

const sha256 = (v: string): string => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
const clean = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().toLowerCase();
const hashed = (v: string): string[] | undefined => (v ? [sha256(v)] : undefined);

const COUNTRY_NAMES: Record<string, string> = {
  australia: 'au', 'new zealand': 'nz', 'united states': 'us', 'united states of america': 'us', usa: 'us',
  'united kingdom': 'gb', uk: 'gb', canada: 'ca', singapore: 'sg', ireland: 'ie', germany: 'de', france: 'fr',
};

export const normEmail = (v: unknown): string => {
  const e = clean(v);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
};
/** Digits only, with country code; Australian local numbers (04…, 02…) get 61. */
export function normPhone(v: unknown, country = 'au'): string {
  let d = clean(v).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (country === 'au' && d.startsWith('0') && d.length === 10) d = `61${d.slice(1)}`;
  return d.length >= 8 ? d : '';
}
export const normName = (v: unknown): string => clean(v).replace(/[\s'".,-]/g, '');
export const normCity = (v: unknown): string => clean(v).replace(/[^a-z]/g, '');
export const normState = (v: unknown): string => clean(v).replace(/[^a-z]/g, '');
export const normZip = (v: unknown): string => clean(v).replace(/\s/g, '');
export function normCountry(v: unknown): string {
  const c = clean(v);
  if (/^[a-z]{2}$/.test(c)) return c;
  return COUNTRY_NAMES[c] ?? '';
}

export interface MetaUserData {
  em?: string[]; ph?: string[]; fn?: string[]; ln?: string[]; ct?: string[]; st?: string[]; zp?: string[];
  country?: string[]; external_id?: string[];
  client_ip_address?: string; client_user_agent?: string; fbp?: string; fbc?: string;
}

export interface MetaServerEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: 'website';
  event_source_url?: string;
  user_data: MetaUserData;
  custom_data?: Record<string, unknown>;
}

const FBP_RE = /^fb\.[0-9]\.[0-9]{10,13}\.[0-9]{1,20}$/;
const FBC_RE = /^fb\.[0-9]\.[0-9]{10,13}\.[A-Za-z0-9_-]{8,500}$/;
export const validFbp = (v: unknown): string | undefined => (typeof v === 'string' && FBP_RE.test(v) ? v : undefined);
export const validFbc = (v: unknown): string | undefined => (typeof v === 'string' && FBC_RE.test(v) ? v : undefined);
/** fbc built from a stored fbclid when the browser had no _fbc cookie (Meta's format). */
export function fbcFromClickId(fbclid: unknown, clickedAt?: Date | string | null): string | undefined {
  if (typeof fbclid !== 'string' || !/^[A-Za-z0-9_-]{8,500}$/.test(fbclid)) return undefined;
  const t = clickedAt ? new Date(clickedAt).getTime() : NaN;
  return `fb.1.${Number.isFinite(t) ? t : Date.now()}.${fbclid}`;
}

const ip = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim().replace(/^::ffff:/, '') : '';
  return s && s.length <= 45 && /^[0-9a-fA-F:.]+$/.test(s) ? s : undefined;
};
const ua = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);

/** user_data from an order: hashed customer details + the browser context captured at checkout. */
export function orderUserData(order: any): MetaUserData {
  const ship = order?.shippingAddressObj || {};
  const bill = order?.billingAddressObj || {};
  const country = normCountry(ship.country || bill.country) || 'au';
  const email = normEmail(order?.customer?.email || order?.customerEmail);
  const fullName = String(order?.customerName || ship.name || '').trim().split(/\s+/);
  const visitor = order?.visitor || {};
  const touch = order?.attribution?.lastTouch?.fbclid ? order.attribution.lastTouch : order?.attribution?.firstTouch;
  const user: MetaUserData = {
    em: hashed(email),
    ph: hashed(normPhone(order?.customer?.phone || ship.phone || bill.phone, country)),
    fn: hashed(normName(order?.customer?.firstName || fullName[0])),
    ln: hashed(normName(order?.customer?.lastName || (fullName.length > 1 ? fullName.slice(1).join(' ') : ''))),
    ct: hashed(normCity(ship.city || bill.city)),
    st: hashed(normState(ship.state || bill.state)),
    zp: hashed(normZip(ship.zip || bill.zip)),
    country: hashed(country),
    external_id: order?.user ? hashed(String(order.user)) : hashed(email),
    client_ip_address: ip(visitor.ip),
    client_user_agent: ua(visitor.userAgent),
    fbp: validFbp(visitor.fbp),
    fbc: validFbc(visitor.fbc) || fbcFromClickId(touch?.fbclid, touch?.capturedAt),
  };
  for (const k of Object.keys(user) as (keyof MetaUserData)[]) if (user[k] === undefined) delete user[k];
  return user;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Purchased items as Meta contents (the success page's Pixel Purchase uses the same list). */
export function metaContents(order: any): Array<{ id: string; quantity: number; item_price: number }> {
  const lines: any[] = Array.isArray(order?.products) ? order.products : [];
  return lines
    .map((p) => ({ id: contentIdFor({ sku: p.sku, productId: p.product?._id ?? p.product }), quantity: Number(p.quantity) || 1, item_price: round2(Number(p.price) || 0) }))
    .filter((c) => c.id);
}

/** Purchase for a paid order, or null when the order is too old for Meta / has no value. */
export function buildPurchaseEvent(order: any, opts: { siteUrl: string; now?: number }): MetaServerEvent | null {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const paidAt = order?.paidAt ? Math.floor(new Date(order.paidAt).getTime() / 1000) : now;
  const eventTime = Math.min(paidAt, now);
  if (now - eventTime > MAX_EVENT_AGE_S) return null;
  const value = Number(order?.grandTotal ?? order?.totalAmount);
  if (!Number.isFinite(value) || value < 0) return null;
  const contents = metaContents(order);
  return {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: purchaseEventId(order._id),
    action_source: 'website',
    event_source_url: `${opts.siteUrl.replace(/\/$/, '')}/checkout/success`,
    user_data: orderUserData(order),
    custom_data: {
      currency: META_CURRENCY,
      value: round2(value),
      content_type: 'product',
      content_ids: [...new Set(contents.map((c) => c.id))],
      contents,
      num_items: contents.reduce((s, c) => s + c.quantity, 0),
      order_id: String(order.orderNumber || order._id),
    },
  };
}

export type RelayResult = { ok: true; event: MetaServerEvent } | { ok: false; reason: string };

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

/**
 * Validate a browser-relayed event. Only whitelisted events, our own pages, bounded custom data;
 * currency is always AUD. IP and user agent come from the request, never from the body.
 */
export function buildRelayedEvent(
  body: any,
  ctx: { ip?: string; userAgent?: string; allowedOrigins: string[]; now?: number }
): RelayResult {
  const name = body?.event_name;
  if (!BROWSER_RELAY_EVENTS.includes(name)) return { ok: false, reason: 'event_name not allowed' };
  const eventId = body?.event_id;
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) return { ok: false, reason: 'invalid event_id' };

  let sourceUrl: string | undefined;
  try {
    const u = new URL(String(body?.event_source_url || ''));
    if (!ctx.allowedOrigins.includes(u.origin)) return { ok: false, reason: 'event_source_url not allowed' };
    u.hash = '';
    sourceUrl = u.toString().slice(0, 1000);
  } catch {
    return { ok: false, reason: 'invalid event_source_url' };
  }

  const cd = body?.custom_data && typeof body.custom_data === 'object' ? body.custom_data : {};
  const custom: Record<string, unknown> = {};
  if (name !== 'PageView') {
    custom.currency = META_CURRENCY;
    const value = Number(cd.value);
    if (Number.isFinite(value) && value >= 0 && value <= 1_000_000) custom.value = round2(value);
    custom.content_type = 'product';
    const ids = Array.isArray(cd.content_ids) ? cd.content_ids.map((x: unknown) => str(x, 100)).filter(Boolean).slice(0, 50) : [];
    if (ids.length) custom.content_ids = ids;
    const contents = Array.isArray(cd.contents)
      ? cd.contents.slice(0, 50).map((c: any) => ({ id: str(c?.id, 100), quantity: Math.min(Math.max(Math.floor(Number(c?.quantity) || 1), 1), 1000), item_price: Number.isFinite(Number(c?.item_price)) ? round2(Math.max(0, Number(c.item_price))) : undefined }))
        .filter((c: any) => c.id)
      : [];
    if (contents.length) custom.contents = contents;
    const numItems = Number(cd.num_items);
    if (Number.isInteger(numItems) && numItems > 0 && numItems <= 10_000) custom.num_items = numItems;
    const contentName = str(cd.content_name, 200);
    if (contentName) custom.content_name = contentName;
  }

  const now = Math.floor((ctx.now ?? Date.now()) / 1000);
  const user: MetaUserData = { client_ip_address: ip(ctx.ip), client_user_agent: ua(ctx.userAgent), fbp: validFbp(body?.fbp), fbc: validFbc(body?.fbc) };
  for (const k of Object.keys(user) as (keyof MetaUserData)[]) if (user[k] === undefined) delete user[k];
  if (!user.client_user_agent) return { ok: false, reason: 'missing user agent' };

  return {
    ok: true,
    event: {
      event_name: name,
      event_time: now,
      event_id: eventId,
      action_source: 'website',
      event_source_url: sourceUrl,
      user_data: user,
      ...(Object.keys(custom).length ? { custom_data: custom } : {}),
    },
  };
}
