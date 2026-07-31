import { Request, Response, NextFunction } from 'express';
import AnalyticsEvent from '../models/analyticsEvent.model';

const VALID_EVENT_TYPES = ['page_view', 'product_view', 'add_to_cart', 'begin_checkout', 'purchase'];

/**
 * POST /api/analytics/events
 * Public endpoint — no auth required.
 * Logs a single analytics event from the storefront.
 * Always returns 200 immediately (fire-and-forget pattern).
 */
export const logEvent = async (req: Request, res: Response): Promise<void> => {
  // Respond immediately — never block the storefront
  res.status(200).json({ success: true });

  try {
    const { sessionId, eventType, timestamp, productId, orderId, country, cartValue, page, productName, path } = req.body;

    // Basic validation — silently ignore invalid events
    if (!sessionId || typeof sessionId !== 'string') return;
    if (!eventType || !VALID_EVENT_TYPES.includes(eventType)) return;

    // Auto-detect country from Cloudflare / IP headers or default to Australia (AU)
    const detectedCountry = country ||
      (req.headers['cf-ipcountry'] as string) ||
      (req.headers['x-country'] as string) ||
      'Australia';

    const eventPath = path || page || '/';

    await AnalyticsEvent.create({
      sessionId: sessionId.slice(0, 128),
      eventType,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      country: detectedCountry,
      productId: productId || undefined,
      productName: productName ? String(productName).slice(0, 256) : undefined,
      orderId: orderId || undefined,
      cartValue: typeof cartValue === 'number' ? cartValue : undefined,
      page: eventPath.slice(0, 512),
      path: eventPath.slice(0, 512),
    });
  } catch (err) {
    // Silently swallow errors — analytics must never break the storefront
    console.error('[Analytics] logEvent error:', err);
  }
};
