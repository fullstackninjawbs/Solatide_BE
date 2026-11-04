/**
 * collect.ts — storefront tracking ingest (POST /api/analytics/collect).
 *
 * The storefront sends batches: { visitorId, sessionId, context, events[], ping? }.
 * - Every event has a client-generated id; an id that was already stored is ignored, so retries,
 *   re-renders and duplicate sends never count twice. Counters only move for newly stored events.
 * - The session record is created on its first batch with where the visit came from (landing page,
 *   referrer, UTMs → traffic source), device and approximate location (server-side IP lookup;
 *   the browser's own lookup only as a fallback). Later batches only update activity, counters,
 *   the live cart and the checkout progress.
 * - A ping (sent while the tab is visible and the visitor recently interacted) only refreshes
 *   lastActivityAt, so "active now" stays true while someone reads a page.
 * - Server time is used; the browser only says how long ago (≤ 60 s) an event happened in a batch.
 */
import AnalyticsEvent, { BROWSER_EVENT_TYPES, CheckoutStage } from '../../models/analyticsEvent.model';
import { AnalyticsSession, AnalyticsVisitor, CheckoutSession } from '../../models/analyticsSession.model';
import { parseUserAgent } from './device';
import { classifyTrafficSource } from './trafficSource';
import { lookupIp, GeoLocation } from './geo';
import { CHECKOUT_ABANDON_MS } from './config';

export const MAX_EVENTS_PER_BATCH = 30;
export const MAX_EVENT_AGE_MS = 15 * 60 * 1000;
const MAX_CART_ITEMS = 25;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const STAGES: CheckoutStage[] = ['information', 'shipping', 'payment'];
const STAGE_RANK: Record<string, number> = { started: 0, information: 1, shipping: 2, payment: 3 };
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] as const;

export class CollectInputError extends Error {}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
};
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const objectId = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) ? v : undefined;
const email = (v: unknown): string | undefined => {
  const s = str(v, 254)?.toLowerCase();
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : undefined;
};
const path = (v: unknown): string | undefined => {
  const s = str(v, 300);
  return s && s.startsWith('/') ? s : undefined;
};
const imageUrl = (v: unknown): string | undefined => {
  const s = str(v, 500);
  return s && (/^https:\/\//.test(s) || s.startsWith('/')) && !/["'<>\s]/.test(s) ? s : undefined;
};

export interface CleanCart { items: any[]; itemCount: number; value: number }
export interface CleanEvent {
  id: string;
  type: (typeof BROWSER_EVENT_TYPES)[number];
  ageMs: number;
  path?: string;
  productId?: string;
  productName?: string;
  productImage?: string;
  variantId?: string;
  variantTitle?: string;
  quantity?: number;
  value?: number;
  stage?: CheckoutStage;
  error?: string;
  checkoutId?: string;
  cart?: CleanCart;
  contact?: { email?: string; firstName?: string; lastName?: string; country?: string };
  paymentMethod?: string;
}
export interface CleanBatch {
  visitorId: string;
  sessionId: string;
  ping: boolean;
  context: {
    landingPage?: string;
    referrer?: string;
    utm: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
    clickIds: Partial<Record<(typeof CLICK_IDS)[number], string>>;
    touch?: boolean;
    location?: { country?: string; region?: string; city?: string };
  };
  events: CleanEvent[];
}

function cleanCart(c: any): CleanCart | undefined {
  if (!c || typeof c !== 'object' || !Array.isArray(c.items)) return undefined;
  const items = c.items.slice(0, MAX_CART_ITEMS).map((i: any) => ({
    productId: objectId(i?.productId),
    variantId: str(i?.variantId, 64),
    name: str(i?.name, 150),
    variantTitle: str(i?.variantTitle, 100),
    image: imageUrl(i?.image),
    path: path(i?.path),
    quantity: num(i?.quantity, 1, 1000),
    unitPrice: num(i?.unitPrice, 0, 1_000_000),
  })).filter((i: any) => i.name && i.quantity);
  const itemCount = items.reduce((n: number, i: any) => n + i.quantity, 0);
  const value = Math.round(items.reduce((n: number, i: any) => n + (i.unitPrice || 0) * i.quantity, 0) * 100) / 100;
  return { items, itemCount, value };
}

/** Validates and normalises a batch; throws CollectInputError on anything malformed. */
export function validateCollectBatch(body: any): CleanBatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CollectInputError('Invalid body');
  const visitorId = typeof body.visitorId === 'string' && ID_RE.test(body.visitorId) ? body.visitorId : null;
  const sessionId = typeof body.sessionId === 'string' && ID_RE.test(body.sessionId) ? body.sessionId : null;
  if (!visitorId || !sessionId) throw new CollectInputError('visitorId and sessionId are required');
  const rawEvents = body.events === undefined ? [] : body.events;
  if (!Array.isArray(rawEvents)) throw new CollectInputError('events must be an array');
  if (rawEvents.length > MAX_EVENTS_PER_BATCH) throw new CollectInputError(`At most ${MAX_EVENTS_PER_BATCH} events per batch`);

  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const utm = ctx.utm && typeof ctx.utm === 'object' ? ctx.utm : {};
  const clicks = ctx.clickIds && typeof ctx.clickIds === 'object' ? ctx.clickIds : {};
  const loc = ctx.location && typeof ctx.location === 'object' ? ctx.location : null;
  const context: CleanBatch['context'] = {
    landingPage: path(ctx.landingPage),
    referrer: str(ctx.referrer, 500),
    utm: { source: str(utm.source, 100), medium: str(utm.medium, 100), campaign: str(utm.campaign, 150), content: str(utm.content, 150), term: str(utm.term, 150) },
    clickIds: Object.fromEntries(CLICK_IDS.map((k) => [k, str(clicks[k], 300)]).filter(([, v]) => v)),
    touch: ctx.touch === true,
    location: loc ? { country: str(loc.country, 100), region: str(loc.region, 100), city: str(loc.city, 100) } : undefined,
  };

  const seen = new Set<string>();
  const events: CleanEvent[] = [];
  for (const e of rawEvents) {
    if (!e || typeof e !== 'object') throw new CollectInputError('Invalid event');
    if (!(BROWSER_EVENT_TYPES as readonly string[]).includes(e.type)) throw new CollectInputError('Invalid event type');
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) throw new CollectInputError('Invalid event id');
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const checkoutId = typeof e.checkoutId === 'string' && ID_RE.test(e.checkoutId) ? e.checkoutId : undefined;
    if (['begin_checkout', 'checkout_step', 'checkout_error'].includes(e.type) && !checkoutId) throw new CollectInputError('checkoutId is required for checkout events');
    const contact = e.contact && typeof e.contact === 'object'
      ? { email: email(e.contact.email), firstName: str(e.contact.firstName, 60), lastName: str(e.contact.lastName, 60), country: str(e.contact.country, 2)?.toUpperCase() }
      : undefined;
    events.push({
      id: e.id,
      type: e.type,
      // How long ago it happened: events re-sent from the storefront's outbox (not delivered when the
      // previous page closed) can be up to 15 minutes old
      ageMs: Math.round(num(e.ageMs, 0, MAX_EVENT_AGE_MS) ?? 0),
      path: path(e.path),
      productId: objectId(e.productId),
      productName: str(e.productName, 150),
      productImage: imageUrl(e.productImage),
      variantId: str(e.variantId, 64),
      variantTitle: str(e.variantTitle, 100),
      quantity: num(e.quantity, -1000, 1000),
      value: num(e.value, 0, 1_000_000),
      stage: STAGES.includes(e.stage) ? e.stage : undefined,
      error: str(e.error, 200),
      checkoutId,
      cart: cleanCart(e.cart),
      contact,
      paymentMethod: str(e.paymentMethod, 40),
    });
  }
  return { visitorId, sessionId, ping: body.ping === true, context, events };
}

const SITE_HOSTS = [
  'solatidebiosciences.com.au',
  ...[process.env.CLIENT_URL, process.env.ADMIN_URL].map((u) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return ''; } }),
].filter(Boolean);

export interface CollectResult { stored: number; duplicates: number; sessionCreated: boolean }

/** Persists a validated batch. */
export async function ingestBatch(batch: CleanBatch, req: { ip?: string; userAgent?: string }, now = new Date()): Promise<CollectResult> {
  const { visitorId, sessionId } = batch;

  // Session belongs to another visitor (tampered / copied storage): ignore
  const existing: any = await AnalyticsSession.findOne({ sessionId }).select('visitorId').lean();
  if (existing && existing.visitorId !== visitorId) return { stored: 0, duplicates: 0, sessionCreated: false };

  // Visitor (null = first time we see this browser)
  const visitorBefore: any = await AnalyticsVisitor.findOneAndUpdate(
    { visitorId },
    { $setOnInsert: { visitorId, firstSeenAt: now, sessionCount: 0 }, $set: { lastSeenAt: now } },
    { upsert: true, new: false }
  ).lean();

  let sessionCreated = false;
  if (!existing) {
    const ctx = batch.context;
    const ipGeo: GeoLocation | null = await lookupIp(req.ip);
    const geo = ipGeo
      ? { ...ipGeo, method: 'ip' }
      : ctx.location?.country ? { country: ctx.location.country, countryCode: '', region: ctx.location.region || '', city: ctx.location.city || '', method: 'browser' } : undefined;
    const source = classifyTrafficSource({ referrer: ctx.referrer, utmSource: ctx.utm.source, utmMedium: ctx.utm.medium, utmCampaign: ctx.utm.campaign, ...ctx.clickIds }, SITE_HOSTS);
    const clickId = (CLICK_IDS as readonly string[]).find((k) => (ctx.clickIds as any)[k]);
    try {
      const res = await AnalyticsSession.updateOne(
        { sessionId },
        {
          $setOnInsert: {
            sessionId, visitorId, startedAt: now, lastActivityAt: now,
            isNewVisitor: !visitorBefore || !visitorBefore.sessionCount,
            landingPage: ctx.landingPage || batch.events.find((e) => e.path)?.path,
            referrer: ctx.referrer,
            source: { ...source, utm: ctx.utm, ...(clickId ? { clickId } : {}) },
            device: parseUserAgent(req.userAgent, { touch: ctx.touch }),
            ...(geo ? { geo } : {}),
          },
        },
        { upsert: true }
      );
      sessionCreated = res.upsertedCount === 1;
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // a parallel batch created it first
    }
    if (sessionCreated) {
      await AnalyticsVisitor.updateOne({ visitorId }, { $inc: { sessionCount: 1 }, $set: { lastSessionId: sessionId } });
    }
  }

  // Events: drop ids already stored, then insert (a parallel duplicate is caught by the unique index)
  let fresh = batch.events;
  if (fresh.length) {
    const known = new Set((await AnalyticsEvent.find({ eventId: { $in: fresh.map((e) => e.id) } }).select('eventId').lean()).map((d: any) => d.eventId));
    fresh = fresh.filter((e) => !known.has(e.id));
  }
  const sessionGeo: any = (await AnalyticsSession.findOne({ sessionId }).select('geo').lean())?.geo || {};
  const docs = fresh.map((e) => ({
    eventId: e.id,
    sessionId, visitorId,
    eventType: e.type,
    timestamp: new Date(now.getTime() - e.ageMs),
    country: sessionGeo.country || 'Unknown', region: sessionGeo.region || undefined, city: sessionGeo.city || undefined,
    productId: e.productId, productName: e.productName, productImage: e.productImage,
    variantId: e.variantId, variantTitle: e.variantTitle, quantity: e.quantity,
    cartValue: e.value ?? e.cart?.value,
    page: e.path || '/', path: e.path || '/',
    stage: e.stage, errorMessage: e.error, checkoutId: e.checkoutId,
    clientReported: false,
  }));
  let stored = docs.length;
  if (docs.length) {
    try {
      await AnalyticsEvent.insertMany(docs, { ordered: false });
    } catch (err: any) {
      const dupes = (err?.writeErrors || []).filter((w: any) => (w.code ?? w.err?.code) === 11000);
      if (!dupes.length) throw err;
      const dupIds = new Set(dupes.map((w: any) => docs[w.index ?? w.err?.index]?.eventId));
      stored -= dupIds.size;
      fresh = fresh.filter((e) => !dupIds.has(e.id));
    }
  }

  await applySessionUpdates(batch, fresh, now);
  await applyCheckoutUpdates(batch, fresh, now);
  return { stored, duplicates: batch.events.length - stored, sessionCreated };
}

async function applySessionUpdates(batch: CleanBatch, allFresh: CleanEvent[], now: Date) {
  const inc: Record<string, number> = {};
  const set: Record<string, unknown> = { lastActivityAt: now };
  // Checkout messages that arrive after their order was submitted (the browser's last batch can
  // reach the server just after the order request) must not put the old cart back or become the
  // "latest action": the order already emptied the cart.
  const checkoutIds = [...new Set(allFresh.map((e) => e.checkoutId).filter(Boolean))] as string[];
  const submitted = new Set(
    checkoutIds.length
      ? (await CheckoutSession.find({ checkoutId: { $in: checkoutIds }, status: 'order_submitted' }).select('checkoutId').lean()).map((c: any) => c.checkoutId)
      : []
  );
  const fresh = allFresh.filter((e) => !(e.checkoutId && submitted.has(e.checkoutId)));
  for (const e of fresh) {
    if (e.type === 'page_view') inc['counts.pageViews'] = (inc['counts.pageViews'] || 0) + 1;
    if (e.type === 'product_view') inc['counts.productViews'] = (inc['counts.productViews'] || 0) + 1;
    if (e.type === 'add_to_cart') inc['counts.addToCart'] = (inc['counts.addToCart'] || 0) + 1;
    if (e.type === 'remove_from_cart') inc['counts.removeFromCart'] = (inc['counts.removeFromCart'] || 0) + 1;
    if (['add_to_cart', 'remove_from_cart', 'cart_quantity_change'].includes(e.type)) inc['counts.cartUpdates'] = (inc['counts.cartUpdates'] || 0) + 1;
  }
  // Latest event (shown on the live cards): not errors / quiet stage updates
  const shown = [...fresh].reverse().find((e) => e.type !== 'checkout_error');
  if (shown) set.lastEvent = { type: shown.type, path: shown.path, productName: shown.productName, productImage: shown.productImage, at: new Date(now.getTime() - shown.ageMs) };
  const lastCart = [...fresh].reverse().find((e) => e.cart);
  if (lastCart?.cart) set.cart = { ...lastCart.cart, updatedAt: now };
  const lastCheckout = [...fresh].reverse().find((e) => e.checkoutId);
  if (lastCheckout) set['checkout.checkoutId'] = lastCheckout.checkoutId;
  const contact = [...fresh].reverse().find((e) => e.contact?.email || e.contact?.firstName)?.contact;
  if (contact) {
    if (contact.email) set['identity.email'] = contact.email;
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    if (name) set['identity.name'] = name;
  }
  await AnalyticsSession.updateOne({ sessionId: batch.sessionId }, { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) });
  if (contact && (contact.email || contact.firstName)) {
    const vset: Record<string, unknown> = {};
    if (contact.email) vset['identity.email'] = contact.email;
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    if (name) vset['identity.name'] = name;
    await AnalyticsVisitor.updateOne({ visitorId: batch.visitorId }, { $set: vset });
  }
}

async function applyCheckoutUpdates(batch: CleanBatch, fresh: CleanEvent[], now: Date) {
  const byCheckout = new Map<string, CleanEvent[]>();
  for (const e of fresh) {
    if (!e.checkoutId || !['begin_checkout', 'checkout_step', 'checkout_error'].includes(e.type)) continue;
    byCheckout.set(e.checkoutId, [...(byCheckout.get(e.checkoutId) || []), e]);
  }
  for (const [checkoutId, events] of byCheckout) {
    const current: any = await CheckoutSession.findOne({ checkoutId }).lean();
    if (current && (current.visitorId !== batch.visitorId || current.status === 'order_submitted')) continue;
    const set: Record<string, unknown> = { lastActivityAt: now, sessionId: batch.sessionId };
    const inc: Record<string, number> = {};
    let rank = STAGE_RANK[current?.stage || 'started'];
    for (const e of events) {
      if (e.type === 'checkout_step' && e.stage && STAGE_RANK[e.stage] > rank) {
        rank = STAGE_RANK[e.stage];
        set[`stageAt.${e.stage}`] = new Date(now.getTime() - e.ageMs);
      }
      if (e.type === 'checkout_error') {
        inc.errorCount = (inc.errorCount || 0) + 1;
        if (e.error) set.lastError = e.error;
      }
      if (e.cart) set.cart = { ...e.cart, updatedAt: now };
      if (e.paymentMethod) set.paymentMethod = e.paymentMethod;
      for (const [k, v] of Object.entries(e.contact || {})) if (v) set[`contact.${k}`] = v;
    }
    set.stage = Object.keys(STAGE_RANK).find((k) => STAGE_RANK[k] === rank);
    // Came back after it counted as abandoned
    if (current && now.getTime() - new Date(current.lastActivityAt).getTime() > CHECKOUT_ABANDON_MS) {
      inc.resumedCount = (inc.resumedCount || 0) + 1;
      set.lastResumedAt = now;
    }
    await CheckoutSession.updateOne(
      { checkoutId },
      {
        $setOnInsert: { checkoutId, visitorId: batch.visitorId, startedAt: now, status: 'in_progress' },
        $set: set,
        ...(Object.keys(inc).length ? { $inc: inc } : {}),
      },
      { upsert: true }
    );
    await AnalyticsSession.updateOne(
      { sessionId: batch.sessionId },
      { $set: { 'checkout.checkoutId': checkoutId, 'checkout.stage': set.stage }, $min: { 'checkout.startedAt': current?.startedAt || now } }
    );
  }
}
