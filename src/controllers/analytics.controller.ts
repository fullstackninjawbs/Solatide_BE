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
    const { sessionId, eventType, timestamp, productId, orderId, country, cartValue, page } = req.body;

    // Basic validation — silently ignore invalid events
    if (!sessionId || typeof sessionId !== 'string') return;
    if (!eventType || !VALID_EVENT_TYPES.includes(eventType)) return;

    await AnalyticsEvent.create({
      sessionId: sessionId.slice(0, 128), // cap length
      eventType,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      country: country || undefined,
      productId: productId || undefined,
      orderId: orderId || undefined,
      cartValue: typeof cartValue === 'number' ? cartValue : undefined,
      page: page ? String(page).slice(0, 512) : undefined,
    });
  } catch (err) {
    // Silently swallow errors — analytics must never break the storefront
    console.error('[Analytics] logEvent error:', err);
  }
};
