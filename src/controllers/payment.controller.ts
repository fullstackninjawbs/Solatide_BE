/**
 * payment.controller.ts
 * ─────────────────────
 * Handles TagadaPay payment flows:
 *   1. createTagadaPayment  — POST /api/payments/tagada/create
 *   2. tagadaWebhook        — POST /api/payments/tagada/webhook
 *   3. testTagadaConnection — GET  /api/admin/settings/tagada/test
 *   4. syncTagadaOrder      — POST /api/payments/tagada/sync/:orderId?accessToken=
 *
 * Post-payment side effects live in services/orders/onOrderPaid.ts and are
 * triggered (idempotently) from every path that marks an order paid.
 */

import { Request, Response, NextFunction } from 'express';
import { getTagadaClient } from '../services/tagadaClient';
import Order from '../models/order.model';
import Product from '../models/product.model';
import PaymentSettings from '../models/PaymentSettings';
import Discount from '../models/Discount';
import ProcessedWebhookEvent from '../models/ProcessedWebhookEvent';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import config from '../config';
import { mapTagadaStatus } from '../domain/orderTransitions';
import {
  verifyTagadaSignature,
  deriveWebhookEventId,
  buildOrderLookupPlan,
  resolveSingleCandidate,
  isUsableExternalId,
} from '../domain/tagadaWebhook';
import { withTimeout, TAGADA_TIMEOUT_MS } from '../domain/withTimeout';
import { generateOrderAccessToken, accessTokenMatches } from '../domain/orderAccess';
import { checkDiscountEligibility } from '../domain/discountEligibility';
import { escapeRegExp } from '../domain/escapeRegExp';
import { roundMoney } from '../domain/money';
import { resolveCheckoutLines, CheckoutValidationError, CheckoutLineInput } from '../services/orders/checkoutItems';
import { applyTagadaDetails, unwrapTagadaObject } from '../services/orders/tagadaOrderMapper';
import { transitionPaymentStatus } from '../services/orders/paymentTransition';
import { scheduleOnOrderPaid } from '../services/orders/onOrderPaid';
import { applyProviderRefundEvent } from '../services/orders/refunds';
import { ensureOrderNumber, generateOrderNumber as genOrderNumber, isDuplicateKeyError } from '../services/orders/orderNumber';
import { syncOrderFromTagada } from '../services/orders/tagadaSync';

/** @deprecated import from services/orders/orderNumber — re-exported for existing callers. */
export const generateOrderNumber = genOrderNumber;

/** Re-exported for tests/back-compat. */
export { mapTagadaStatus };

/** Minimal, non-PII projection returned to public (guest) callers. */
export function publicOrderView(order: any) {
  const o = order?.toObject ? order.toObject() : order;
  const products = Array.isArray(o?.products) ? o.products : [];
  const lineItems = Array.isArray(o?.lineItems) && o.lineItems.length
    ? o.lineItems.map((li: any) => ({ name: li.title, variant: li.variantTitle, quantity: li.quantity, price: li.unitPrice }))
    : products.map((p: any) => ({ name: p.title || p.product?.name || 'Product', variant: p.variantTitle, quantity: p.quantity, price: p.price }));
  return {
    _id: o?._id,
    orderNumber: o?.orderNumber,
    paymentStatus: o?.paymentStatus,
    status: o?.status,
    items: lineItems,
    subtotal: o?.subtotal,
    shippingAmount: o?.shippingAmount,
    taxAmount: o?.taxAmount,
    discountAmount: o?.discountAmount,
    grandTotal: o?.grandTotal ?? o?.totalAmount,
    currency: o?.currency,
  };
}

// ─── 1. Create TagadaPay Payment ─────────────────────────────────────────────

/**
 * POST /api/payments/tagada/create
 * Body: { orderId, accessToken?, items?: [{productId, variantId?, tagadaVariantId?, quantity}], attribution?, couponCode? }
 *
 * Resolves variants/prices/stock server-side, (re)writes the pending order's
 * lines, creates the Tagada checkout session and returns the redirect URL plus
 * the order's public access token.
 */
export const createTagadaPayment = catchAsync(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const { orderId, attribution, items, couponCode, visitor } = req.body ?? {};
    const providedToken = req.body?.accessToken ?? req.query?.accessToken;

    if (!orderId || typeof orderId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(orderId)) {
      return next(new AppError('A valid orderId is required', 400));
    }

    const order: any = await Order.findById(orderId).select('+publicAccessToken').populate('user', 'name email');
    if (!order) return next(new AppError('Order not found', 404));

    // Access token: if the order already has one, the caller must present it.
    if (order.publicAccessToken) {
      if (!accessTokenMatches(order.publicAccessToken, providedToken)) {
        return next(new AppError('Invalid or missing order access token', 403));
      }
    } else {
      order.publicAccessToken = generateOrderAccessToken();
    }

    if (order.paymentStatus !== 'pending') {
      return next(new AppError(`Payment cannot be initiated. Order paymentStatus is '${order.paymentStatus}'.`, 400));
    }

    // Attribution (bounded strings)
    if (attribution && typeof attribution === 'object') {
      if (!order.attribution) order.attribution = {};
      const clip = (t: any) => (t && typeof t === 'object' ? {
        ...t,
        source: typeof t.source === 'string' ? t.source.substring(0, 255) : undefined,
        channel: typeof t.channel === 'string' ? t.channel.substring(0, 255) : undefined,
      } : undefined);
      if (attribution.firstTouch && !order.attribution.firstTouch?.source) order.attribution.firstTouch = clip(attribution.firstTouch);
      if (attribution.lastTouch) order.attribution.lastTouch = clip(attribution.lastTouch);
    }

    // Visitor context (analytics session + IP-detected location) for the server-side purchase event
    if (visitor && typeof visitor === 'object') {
      const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().substring(0, max) : undefined);
      const v = { sessionId: str(visitor.sessionId, 128), country: str(visitor.country, 100), region: str(visitor.region, 100), city: str(visitor.city, 100) };
      if (v.sessionId || v.country) order.visitor = v;
    }

    // Resolve lines server-side (M-11)
    let inputs: CheckoutLineInput[];
    if (Array.isArray(items) && items.length > 0) {
      inputs = items;
    } else {
      // Legacy client: derive from the stored order lines.
      const legacy = await Order.findById(orderId).populate('products.product', 'tagadaVariantId variants').lean();
      inputs = ((legacy as any)?.products ?? []).map((p: any) => ({
        productId: String(p.product?._id ?? p.product),
        variantId: p.variant ? String(p.variant) : undefined,
        tagadaVariantId: p.variant ? undefined
          : (p.product?.variants?.find((v: any) => v.tagadaVariantId)?.tagadaVariantId || p.product?.tagadaVariantId),
        quantity: p.quantity ?? 1,
      }));
    }

    let lines;
    try {
      lines = await resolveCheckoutLines(inputs, (id) => Product.findById(id).lean());
    } catch (err: any) {
      if (err instanceof CheckoutValidationError) return next(new AppError(err.message, 400));
      throw err;
    }

    const subtotal = roundMoney(lines.reduce((s, l) => s + l.price * l.quantity, 0));
    order.products = lines.map((l) => ({
      product: l.product, variant: l.variant, quantity: l.quantity, price: l.price,
      tagadaVariantId: l.tagadaVariantId, sku: l.sku, title: l.title, variantTitle: l.variantTitle,
    }));
    order.subtotal = subtotal;
    order.totalAmount = subtotal;

    // Optional local discount pre-check (codes are normally entered on the Tagada page;
    // limits are enforced again atomically in onOrderPaid).
    if (typeof couponCode === 'string' && couponCode.trim()) {
      const discount: any = await Discount.findOne({ code: { $regex: `^${escapeRegExp(couponCode.trim(), 64)}$`, $options: 'i' } }).lean();
      const email = String(order.customerEmail || order.user?.email || '').toLowerCase();
      const customerUses = discount && email
        ? await Order.countDocuments({ couponCode: discount.code, customerEmail: email, paymentStatus: { $in: ['paid', 'partially_refunded', 'refunded'] } })
        : undefined;
      const elig = checkDiscountEligibility(discount, {
        subtotal, quantity: lines.reduce((s, l) => s + l.quantity, 0), customerUses,
      });
      if (!elig.ok) return next(new AppError(elig.reason, 400));
      order.couponCode = discount.code;
    }

    const customerEmail: string = order.customerEmail || order.user?.email || '';
    const customerName: string = order.customerName || order.user?.name || '';

    const originHeader = req.headers.origin || (Array.isArray(config.corsOrigin) ? config.corsOrigin[0] : config.corsOrigin);
    const clientOrigin = String(originHeader).replace(/\/$/, '');
    const returnUrl = `${clientOrigin}/checkout/success`;

    let session: any;
    try {
      const client = await getTagadaClient();
      let checkoutUrl = config.tagadaCheckoutUrl;
      if (process.env.NODE_ENV !== 'production' && process.env.TAGADA_TEST_CHECKOUT_URL) {
        checkoutUrl = process.env.TAGADA_TEST_CHECKOUT_URL;
      }
      const sessionPayload: any = {
        storeId: config.tagadaStoreId,
        items: lines.map((l) => ({ variantId: l.tagadaVariantId, quantity: l.quantity })),
        currency: order.currency || config.tagadaDefaultCurrency,
        returnUrl,
        cartToken: order._id.toString(),
        externalOrderId: order._id.toString(),
        checkoutUrl: checkoutUrl || undefined,
        metadata: {
          order_id: order._id.toString(),
          attribution_source: order.attribution?.firstTouch?.source || 'Direct / Unknown',
          attribution_channel: order.attribution?.firstTouch?.channel || 'direct',
          utm_campaign: order.attribution?.firstTouch?.utmCampaign || '',
        },
      };
      session = await withTimeout(client.checkout.createSession(sessionPayload), TAGADA_TIMEOUT_MS, 'tagada.checkout.createSession');
    } catch (err: any) {
      console.error('[TagadaPay SDK] createSession error:', err?.response?.status ?? '', err?.message);
      const status = err?.name === 'TimeoutError' ? 504 : (err?.response?.status ?? 502);
      return next(new AppError('TagadaPay session creation failed', status >= 400 && status < 600 ? status : 502));
    }

    if (!session?.redirectUrl) {
      console.error(`[TagadaPay] No redirectUrl in session response for order=${orderId}`);
      return next(new AppError('TagadaPay did not return a checkout URL. Check storeId and API key configuration.', 502));
    }

    order.tagadaPaymentId = isUsableExternalId(session.id) ? session.id : null; // never 'unknown'
    order.tagadaPaymentStatus = 'initiated';
    order.tagadaEnv = config.tagadaEnv;
    order.paymentMethod = 'tagada';
    try {
      await order.save({ validateBeforeSave: false });
    } catch (err: any) {
      if (isDuplicateKeyError(err, 'tagadaPaymentId')) {
        console.error(`[TagadaPay] Session id collision for order=${orderId}`);
        return next(new AppError('Checkout session conflict, please retry', 409));
      }
      throw err;
    }

    console.log(`[TagadaPay] Session created | orderId=${orderId} | sessionId=${session.id ?? '-'}`);

    res.status(200).json({
      success: true,
      paymentId: session.id ?? null,
      status: 'initiated',
      checkoutUrl: session.redirectUrl,
      clientToken: null,
      orderId: order._id,
      accessToken: order.publicAccessToken,
    });
  }
);

// ─── 2. TagadaPay Webhook ─────────────────────────────────────────────────────

/** Single best-effort Tagada retrieve inside the webhook request (kept short so we ACK < 5 s). */
const WEBHOOK_INLINE_FETCH_MS = 3000;

async function findOrderForWebhook(payload: any): Promise<{ order: any | null; status?: number; reason?: string }> {
  const plan = buildOrderLookupPlan(payload);
  if (plan.kind === 'conflict') return { order: null, status: 400, reason: plan.reason };
  if (plan.kind === 'none') return { order: null, status: 200, reason: 'no identifiers' };

  if (plan.kind === 'byId') {
    const byId = await Order.findById(plan.orderId);
    if (byId) return { order: byId };
    if (!plan.fallbackClauses.length) return { order: null, status: 200, reason: `order ${plan.orderId} not found` };
    return findByClauses(plan.fallbackClauses);
  }
  return findByClauses(plan.clauses);
}

async function findByClauses(clauses: Array<Record<string, string>>) {
  const candidates = await Order.find({ $or: clauses }).limit(5);
  const r = resolveSingleCandidate(candidates);
  if (r.kind === 'found') return { order: r.order };
  if (r.kind === 'ambiguous') return { order: null, status: 202, reason: `ambiguous: ${r.ids.join(',')}` };
  return { order: null, status: 200, reason: 'no matching order' };
}

/**
 * POST /api/payments/tagada/webhook
 *
 * Design (L-9 / H-5): the request is processed INLINE but time-boxed (one Tagada
 * retrieve ≤ 3 s, no retry loop), and acknowledged only after the state change
 * is persisted. If processing throws, the dedupe record is removed and we return
 * 500 so Tagada redelivers — safer than ACK-then-process, where a crash after
 * the ACK would silently lose a payment. Slow work (emails, inventory, CRM,
 * detail-refresh retries) runs after the response in onOrderPaid.
 */
export const tagadaWebhook = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['x-tagadapay-signature'] as string | undefined;
  if (!signature) {
    console.warn('[TagadaPay Webhook] Missing x-tagadapay-signature header');
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  const settings = await PaymentSettings.findOne();
  const secret = settings?.tagadaWebhookSecret || config.tagadaWebhookSecret;
  if (!secret) {
    console.error('[TagadaPay Webhook] Webhook secret is not configured (DB or env). Cannot verify signature.');
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  const rawBody: Buffer | string = (req as any).rawBody ?? req.body;
  if (!rawBody || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) {
    res.status(400).json({ error: 'Missing raw body' });
    return;
  }
  if (!verifyTagadaSignature(rawBody, signature, secret)) {
    console.warn(`[TagadaPay Webhook] Signature mismatch (secret source: ${settings?.tagadaWebhookSecret ? 'database' : 'env'})`);
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const rawEventType = payload.type || req.headers['x-tagadapay-event'] || '';
  const eventType = String(Array.isArray(rawEventType) ? rawEventType[0] ?? '' : rawEventType);
  if (!eventType.startsWith('payment/') && !eventType.startsWith('order/')) {
    res.status(200).json({ ignored: true, eventType });
    return;
  }

  // Replay protection: claim the event id.
  const { eventId, source } = deriveWebhookEventId(rawBody, req.headers as any, payload);
  try {
    await ProcessedWebhookEvent.create({ provider: 'tagada', eventId, eventIdSource: source, eventType, status: 'received' });
  } catch (err: any) {
    if (!isDuplicateKeyError(err)) throw err;
    // A delivery whose earlier processing failed is re-claimed atomically (status failed → received)
    // instead of deleting its record, so Tagada redeliveries are retried and nothing is ever removed.
    const reclaimed = await ProcessedWebhookEvent.findOneAndUpdate(
      { provider: 'tagada', eventId, status: 'failed' },
      { $set: { status: 'received', error: null } }
    );
    if (!reclaimed) {
      console.log(`[TagadaPay Webhook] Duplicate event ${eventId.slice(0, 24)}… (${eventType}) — skipped`);
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
  }

  const markEvent = (fields: Record<string, unknown>) =>
    ProcessedWebhookEvent.updateOne({ provider: 'tagada', eventId }, { $set: fields }).catch(() => undefined);

  try {
    const d: any = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const tagadaStatus: string = typeof d.status === 'string' ? d.status : '';
    const mapped = mapTagadaStatus(tagadaStatus, eventType);
    console.log(`[TagadaPay Webhook] event=${eventType} status=${tagadaStatus || '-'} mapped=${mapped ?? '-'}`);

    const found = await findOrderForWebhook(payload);
    if (!found.order) {
      console.warn(`[TagadaPay Webhook] Order not resolved (${found.reason}) for event=${eventType}`);
      await markEvent({ status: found.status && found.status !== 200 ? 'failed' : 'ignored', error: found.reason });
      // Conflicting ids → 400, ambiguous match → 202 (refused, logged for manual review),
      // unknown order → 200 so Tagada stops retrying. Never guess an order.
      res.status(found.status ?? 200).json({ received: true, matched: false });
      return;
    }
    const order = found.order;

    // Record provider identifiers (never 'unknown' / undefined).
    const tagadaOrderId = d.orderId ?? d.order_id;
    const tagadaSessionId = d.checkoutSessionId ?? d.sessionId ?? d.session_id;
    const providerPaymentId = d.paymentId ?? (eventType.startsWith('payment/') ? d.id : undefined);
    if (isUsableExternalId(tagadaOrderId) && !order.tagadaOrderId) order.tagadaOrderId = tagadaOrderId;
    if (isUsableExternalId(tagadaSessionId) && !order.tagadaSessionId) order.tagadaSessionId = tagadaSessionId;
    if (isUsableExternalId(providerPaymentId)) order.tagadaProviderPaymentId = providerPaymentId;
    if (!isUsableExternalId(order.tagadaPaymentId) && isUsableExternalId(d.checkoutSessionId)) order.tagadaPaymentId = d.checkoutSessionId;
    if (tagadaStatus) order.tagadaPaymentStatus = ['initiated', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded', 'succeeded', 'pending', 'cancelled'].includes(tagadaStatus) ? tagadaStatus : 'unknown';
    order.paymentMethod = 'tagada';

    if (mapped === 'paid') {
      // Enrich: webhook data first, then one short retrieve (best effort).
      let fullOrder: any = d;
      const target = [tagadaOrderId, order.tagadaOrderId, tagadaSessionId, order.tagadaSessionId, order.tagadaPaymentId].find(isUsableExternalId);
      if (target) {
        try {
          const client = await getTagadaClient();
          const call = String(target).startsWith('cs_') ? client.checkout.retrieveSession(target) : client.orders.retrieve(target);
          fullOrder = unwrapTagadaObject(await withTimeout(call, WEBHOOK_INLINE_FETCH_MS, 'tagada.retrieve(webhook)')) || d;
        } catch (err: any) {
          console.warn(`[TagadaPay Webhook] Inline retrieve failed for order=${order._id}: ${err?.message} — using webhook data`);
        }
      }
      applyTagadaDetails(order, fullOrder, d);
      if (isUsableExternalId(tagadaOrderId)) {
        order.tags = Array.from(new Set([...(order.tags ?? []), tagadaOrderId]));
      }
      await order.save({ validateBeforeSave: false });

      const t = await transitionPaymentStatus(order._id, 'paid');
      await ensureOrderNumber(order._id);
      await markEvent({ status: 'processed', order: order._id });
      res.status(200).json({ received: true, transition: t.result });
      if (t.result === 'applied' || t.result === 'noop') scheduleOnOrderPaid(order._id);
      return;
    }

    await order.save({ validateBeforeSave: false });

    if (mapped === 'refunded' || mapped === 'partially_refunded' || eventType.includes('refund')) {
      await applyProviderRefundEvent(order._id, d, mapped);
    } else if (mapped === 'failed' || mapped === 'cancelled') {
      await transitionPaymentStatus(order._id, mapped);
    }
    await markEvent({ status: 'processed', order: order._id });
    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`[TagadaPay Webhook] Processing failed for event=${eventType}: ${err?.message}`);
    // Mark the claim as failed (never deleted) so Tagada's redelivery re-claims and retries it.
    await markEvent({ status: 'failed', error: String(err?.message ?? 'error').slice(0, 500) });
    if (!res.headersSent) res.status(500).json({ error: 'Processing failed' });
  }
});

// ─── 3. Test TagadaPay Connection ─────────────────────────────────────────────

export const testTagadaConnection = catchAsync(
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const axios = require('axios').default;
      const env = config.tagadaEnv;
      const apiKey = env === 'production' ? config.tagadaApiKeyProd : config.tagadaApiKeySandbox;
      const baseUrl = env === 'production' ? 'https://app.tagadapay.com/api/public/v1' : 'https://app.tagadapay.dev/api/public/v1';
      await axios.get(`${baseUrl}/payments`, {
        params: { limit: 1 },
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: TAGADA_TIMEOUT_MS,
      });
      res.status(200).json({ success: true, message: `TagadaPay connection successful (env: ${config.tagadaEnv})`, env: config.tagadaEnv });
    } catch (err: any) {
      const status = err?.response?.status ?? 502;
      console.error('[TagadaPay Test] Connection error:', err?.response?.status ?? '', err?.message);
      return next(new AppError('TagadaPay connection failed — check your API key and environment', status));
    }
  }
);

// ─── 4. Public success-page sync ──────────────────────────────────────────────

/**
 * POST /api/payments/tagada/sync/:orderId?accessToken=<token>
 * Requires the order's public access token. Returns a minimal, non-PII view.
 */
export const syncTagadaOrder = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { orderId } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(orderId)) return next(new AppError('Order not found', 404));
    const token = (req.query?.accessToken ?? req.body?.accessToken) as unknown;

    const guard: any = await Order.findById(orderId).select('+publicAccessToken paymentMethod paymentStatus').lean();
    // Same 404 for missing order and bad token — no order-existence oracle.
    if (!guard || !accessTokenMatches(guard.publicAccessToken, token)) {
      return next(new AppError('Order not found', 404));
    }

    if (guard.paymentMethod !== 'tagada') return next(new AppError('Order was not paid using Tagada', 400));

    // Already final — no need to call Tagada again.
    if (guard.paymentStatus !== 'pending' && guard.paymentStatus !== 'failed') {
      const current = await Order.findById(orderId).lean();
      res.status(200).json({ success: true, data: { order: publicOrderView(current) } });
      return;
    }

    try {
      const result = await syncOrderFromTagada(orderId, { timeoutMs: 8000 });
      if (result.becamePaid) scheduleOnOrderPaid(orderId);
      res.status(200).json({ success: true, message: 'Order synced with Tagada', data: { order: publicOrderView(result.order) } });
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 400) return next(new AppError(err.message, err.statusCode));
      console.error(`[TagadaPay Sync] order=${orderId} failed: ${err?.message}`);
      return next(new AppError('Failed to fetch details from Tagada', err?.name === 'TimeoutError' ? 504 : 502));
    }
  }
);
