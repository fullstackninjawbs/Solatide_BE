import { Request, Response } from 'express';
import mongoose from 'mongoose';
import AnalyticsEvent from '../models/analyticsEvent.model';
import { validateCollectBatch, ingestBatch, CollectInputError } from '../services/analytics/collect';

export const VALID_EVENT_TYPES = ['page_view', 'product_view', 'add_to_cart', 'begin_checkout', 'purchase'] as const;
export const ANALYTICS_MAX_STRING = 200;

const STRING_FIELDS = ['sessionId', 'eventType', 'productName', 'path', 'page', 'country', 'region', 'city'] as const;

const clip = (v: unknown, max = ANALYTICS_MAX_STRING): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const objectIdOrUndefined = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) && mongoose.Types.ObjectId.isValid(v) ? v : undefined;

/**
 * Validate an incoming event. Returns an error string, or null when valid.
 */
export const validateAnalyticsEvent = (body: any): string | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid body';
  for (const f of STRING_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return `${f} must be a string`;
    if (v.length > ANALYTICS_MAX_STRING) return `${f} exceeds ${ANALYTICS_MAX_STRING} characters`;
  }
  if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) return 'sessionId is required';
  if (!(VALID_EVENT_TYPES as readonly string[]).includes(body.eventType)) return 'Invalid eventType';
  if (body.cartValue !== undefined && body.cartValue !== null) {
    if (typeof body.cartValue !== 'number' || !Number.isFinite(body.cartValue) || body.cartValue < 0 || body.cartValue > 1_000_000) {
      return 'Invalid cartValue';
    }
  }
  return null;
};

/**
 * POST /api/analytics/events
 * Public endpoint — no auth required. Rate limited and body-capped (100kb) in app.ts.
 * - strict type/length validation (400 on invalid)
 * - server time only (client timestamp ignored)
 * - client-sent `purchase` events are stored with clientReported:true so revenue
 *   dashboards can exclude them (purchases should be derived from paid orders)
 */
/** Crawlers / headless browsers / monitors that run JavaScript (they probe e.g. random /<uuid> URLs). */
export const BOT_UA = /bot\b|crawler|spider|crawling|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|slurp|bingpreview|ahrefs|semrush|mj12|dotbot|petalbot|yandex|baidu|python-requests|curl\/|wget\//i;
export const isBotUserAgent = (ua: unknown): boolean => typeof ua !== 'string' || ua.trim() === '' || BOT_UA.test(ua);

/**
 * POST /api/analytics/collect — storefront tracking batches (visitor / session / events).
 * Public, rate limited, body-capped. Validated before the response; stored after it, so the
 * storefront is never slowed down. Bots are acknowledged but not stored.
 */
export const collect = async (req: Request, res: Response): Promise<void> => {
  let batch;
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { throw new CollectInputError('Invalid JSON'); }
    }
    batch = validateCollectBatch(body);
  } catch (err) {
    if (err instanceof CollectInputError) {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    throw err;
  }
  res.status(200).json({ success: true });
  if (isBotUserAgent(req.headers['user-agent'])) return;
  try {
    await ingestBatch(batch, { ip: req.ip, userAgent: req.headers['user-agent'] });
  } catch (err) {
    console.error('[Analytics] collect error:', (err as Error).message);
  }
};

/** Previous single-event endpoint, kept for storefront pages still open from before the update. */
export const logEvent = async (req: Request, res: Response): Promise<void> => {
  const error = validateAnalyticsEvent(req.body);
  if (error) {
    res.status(400).json({ success: false, message: error });
    return;
  }

  // Respond immediately — never block the storefront
  res.status(200).json({ success: true });

  // Bots and requests without a browser user agent are acknowledged but not stored
  if (isBotUserAgent(req.headers['user-agent'])) return;

  try {
    const b = req.body;
    const header = (name: string) => clip(req.headers[name] as string | undefined, 100);

    const detectedCountry = clip(b.country, 100) || header('cf-ipcountry') || header('x-country') || 'Unknown';
    const detectedRegion = clip(b.region, 100) || header('cf-region');
    const detectedCity = clip(b.city, 100) || header('cf-ipcity');
    const eventPath = clip(b.path) || clip(b.page) || '/';

    const doc: Record<string, unknown> = {
      sessionId: clip(b.sessionId, 128),
      eventType: b.eventType,
      timestamp: new Date(), // server time; client timestamps are not trusted
      country: detectedCountry,
      region: detectedRegion,
      city: detectedCity,
      productId: objectIdOrUndefined(b.productId),
      productName: clip(b.productName),
      orderId: objectIdOrUndefined(b.orderId),
      cartValue: typeof b.cartValue === 'number' ? b.cartValue : undefined,
      page: eventPath,
      path: eventPath,
    };
    const event = new AnalyticsEvent(doc);
    if (b.eventType === 'purchase') {
      // strict:false so clientReported persists even before the schema declares it
      event.set('clientReported', true, { strict: false });
    }
    await event.save();
  } catch (err) {
    // Silently swallow errors — analytics must never break the storefront
    console.error('[Analytics] logEvent error:', (err as Error).message);
  }
};
