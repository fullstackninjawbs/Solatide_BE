import { Request, Response } from 'express';
import mongoose from 'mongoose';
import AnalyticsEvent from '../models/analyticsEvent.model';

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
export const logEvent = async (req: Request, res: Response): Promise<void> => {
  const error = validateAnalyticsEvent(req.body);
  if (error) {
    res.status(400).json({ success: false, message: error });
    return;
  }

  // Respond immediately — never block the storefront
  res.status(200).json({ success: true });

  try {
    const b = req.body;
    const header = (name: string) => clip(req.headers[name] as string | undefined, 100);

    const detectedCountry = clip(b.country, 100) || header('cf-ipcountry') || header('x-country') || 'Australia';
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
