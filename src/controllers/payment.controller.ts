/**
 * payment.controller.ts
 * ─────────────────────
 * Handles TagadaPay payment flows:
 *   1. createTagadaPayment  — POST /api/payments/tagada/create
 *   2. tagadaWebhook        — POST /api/payments/tagada/webhook
 *   3. testTagadaConnection — GET  /api/admin/settings/tagada/test
 *
 * Flow overview:
 *   Customer → frontend → POST /create → TagadaPay API → checkoutUrl returned
 *   TagadaPay → POST /webhook → status update → order marked paid/failed/refunded
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { tagadaClient, getTagadaClient } from '../services/tagadaClient';
import Order from '../models/order.model';
import Customer from '../models/Customer';
import PaymentSettings from '../models/PaymentSettings';
import Refund from '../models/Refund';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import config from '../config';
import { sendOrderConfirmationEmail } from '../services/emailService';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TagadaPaymentResponse {
  id: string;
  status: string;
  checkoutUrl?: string;
  clientToken?: string;
  reference?: string;
}

interface TagadaWebhookPayload {
  type: string | string[] | undefined;
  metadata: any;
  event: string;
  data: {
    checkoutSessionId: any;
    paymentId: any;
    cartToken: null;
    id: string;            // TagadaPay payment id
    status: string;        // authorized | captured | failed | refunded | created
    reference?: string;    // our internal orderId passed as metadata
    amount?: number;
    currency?: string;
    // Checkout-enriched fields (present on checkout.completed / payment.captured)
    customer?: {
      first_name?: string;
      last_name?: string;
      email?: string;
      phone?: string;
    };
    shipping_address?: {
      name?: string;
      company?: string;
      address1?: string;
      address2?: string;
      city?: string;
      province?: string;
      zip?: string;
      country?: string;
    };
    billing_address?: {
      name?: string;
      company?: string;
      address1?: string;
      address2?: string;
      city?: string;
      province?: string;
      zip?: string;
      country?: string;
    };
    line_items?: Array<{
      title?: string;
      variant_title?: string;
      sku?: string;
      quantity?: number;
      price?: number | string;
      image_url?: string;
    }>;
    subtotal_price?: number | string;
    shipping_price?: number | string;
    tax_price?: number | string;
    total_price?: number | string;
    shipping_lines?: Array<{ title?: string; code?: string; price?: number | string }>;
    order_id?: string;    // Tagada's own order reference
    session_id?: string;
    metadata?: Record<string, any>;
    tags?: string[];
  };
}

// ─── Helper: map Tagada status → internal paymentStatus ──────────────────────

function mapTagadaStatus(tagadaStatus: string): 'pending' | 'paid' | 'failed' | 'refunded' {
  switch (tagadaStatus) {
    case 'succeeded':
    case 'paid':
    case 'authorized':
    case 'captured':
    case 'partially_refunded':
      return 'paid';
    case 'failed':
    case 'declined':
      return 'failed';
    case 'refunded':
      return 'refunded';
    default:
      return 'pending';
  }
}

// ─── 1. Create TagadaPay Payment ─────────────────────────────────────────────

/**
 * POST /api/payments/tagada/create
 *
 * Loads the order, validates its state, creates a payment with TagadaPay,
 * persists the Tagada payment ID, and returns checkout URL / client token
 * to the frontend.
 */
export const createTagadaPayment = catchAsync(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const { orderId } = req.body;

    if (!orderId) {
      return next(new AppError('orderId is required', 400));
    }

    // 1) Load order — populate user for email/name and products for Tagada variant IDs
    const order = await Order.findById(orderId)
      .populate('user', 'name email')
      .populate('products.product', 'name tagadaVariantId variants');

    if (!order) {
      return next(new AppError(`No order found with id ${orderId}`, 404));
    }

    // 2) Guard: only initiate payment on pending orders
    if (order.paymentStatus !== 'pending') {
      return next(
        new AppError(
          `Payment cannot be initiated. Order paymentStatus is '${order.paymentStatus}'.`,
          400
        )
      );
    }

    // 3) Resolve customer info from the populated user
    const populatedUser = order.user as any; // populated by pre-find hook
    const customerEmail: string =
      order.customerEmail ?? populatedUser?.email ?? '';
    const customerName: string =
      order.customerName ?? populatedUser?.name ?? 'Valued Customer';

    // 4) Build Tagada payload
    // Only include items that have a Tagada variantId — required by CheckoutInitParams
    const rawItems = (order.products ?? []).map((item: any) => {
      const variantId =
        item.product?.tagadaVariantId ||
        item.product?.variants?.find((v: any) => v.tagadaVariantId)?.tagadaVariantId;
      return variantId
        ? { variantId: String(variantId), quantity: item.quantity || 1 }
        : null;
    }).filter(Boolean) as Array<{ variantId: string; quantity: number }>;

    if (rawItems.length === 0) {
      console.error('[TagadaPay] No items with a valid tagadaVariantId — cannot create session');
      return next(new AppError('No Tagada variant IDs found on this order. Please ensure products have a tagadaVariantId configured.', 400));
    }

    const clientOrigin = config.corsOrigin.replace(/\/$/, '');
    const returnUrl = `${clientOrigin}/checkout/success`;

    // 5) Call TagadaPay SDK to create session
    let session: any;
    try {
      const client = await getTagadaClient();

      let checkoutUrl = config.tagadaCheckoutUrl;
      if (process.env.NODE_ENV !== 'production' && process.env.TAGADA_TEST_CHECKOUT_URL) {
        checkoutUrl = process.env.TAGADA_TEST_CHECKOUT_URL;
        console.log('[DEBUG] Using Test Checkout URL:', checkoutUrl);
      }

      const sessionPayload: any = {
        storeId: config.tagadaStoreId,
        items: rawItems,
        currency: order.currency || config.tagadaDefaultCurrency,
        returnUrl,
        cartToken: order._id.toString(),
        externalOrderId: order._id.toString(),
        checkoutUrl: checkoutUrl || undefined,
        customerEmail: customerEmail || undefined,
        customerFirstName: customerName.split(' ')[0] || undefined,
        customerLastName: customerName.split(' ').slice(1).join(' ') || undefined,
        metadata: {
          order_id: order._id.toString()
        }
      };

      session = await client.checkout.createSession(sessionPayload);
    } catch (err: any) {
      console.error('[TagadaPay SDK] createSession error:', err?.response?.data ?? err.message);
      const status = err?.response?.status ?? 502;
      const message =
        err?.response?.data?.message ?? err.message ?? 'TagadaPay session creation failed';
      return next(new AppError(message, status));
    }

    // 6) Persist Tagada session id on the order
    order.tagadaPaymentId = session.id ?? session.redirectUrl ?? 'unknown';
    order.tagadaPaymentStatus = 'initiated';
    order.tagadaEnv = config.tagadaEnv;
    order.paymentMethod = 'tagada';
    // paymentStatus stays 'pending' — webhook will flip it to 'paid'
    await order.save({ validateBeforeSave: false });

    console.log(
      `[TagadaPay] Session created | orderId=${orderId} | sessionId=${session.id} | redirectUrl=${session.redirectUrl}`
    );
    // Log full session in non-prod for debugging
    if (config.env !== 'production') {
      console.log('[TagadaPay] Full session object:', JSON.stringify(session, null, 2));
    }

    // Guard: if Tagada returned no redirect URL something went wrong
    if (!session.redirectUrl) {
      console.error('[TagadaPay] No redirectUrl in session response:', JSON.stringify(session));
      return next(new AppError('TagadaPay did not return a checkout URL. Check storeId and API key configuration.', 502));
    }

    // 7) Return redirect URL to frontend
    res.status(200).json({
      success: true,
      paymentId: session.id,
      status: 'initiated',
      checkoutUrl: session.redirectUrl,
      clientToken: null,
    });
  }
);

// ─── 2. TagadaPay Webhook ─────────────────────────────────────────────────────

/**
 * Generate a human-readable order number like SOL-00042.
 * Uses the total count of orders at the time of creation.
 */
async function generateOrderNumber(): Promise<string> {
  const count = await Order.countDocuments();
  const padded = String(count + 1).padStart(5, '0');
  return `SOL-${padded}`;
}

/**
 * POST /api/payments/tagada/webhook
 *
 * Receives async payment status updates from TagadaPay.
 * No auth middleware — Tagada must be able to reach this endpoint.
 * Signature is verified via HMAC-SHA256 before processing.
 *
 * On a paid/captured event this handler:
 *  1. Verifies HMAC-SHA256 signature
 *  2. Parses the full Tagada payload (customer, addresses, line items, totals)
 *  3. Upserts all structured fields onto the matching Order document
 *  4. Generates an orderNumber if one doesn't exist yet
 *  5. Always returns 200 to prevent Tagada from retrying
 *
 * NOTE: This route must receive the raw body buffer (not parsed JSON).
 * Register it in server.ts BEFORE the global express.json() middleware,
 * or use express.raw() on this route specifically.
 */
export const tagadaWebhook = catchAsync(async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // 1) Verify HMAC-SHA256 signature
  const signature = req.headers['x-tagadapay-signature'] as string | undefined;

  if (!signature) {
    console.warn('[TagadaPay Webhook] Missing x-tagadapay-signature header');
    console.log('[TagadaPay Webhook] Received headers:', req.headers);
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  // Fetch DB settings or fallback to env
  const settings = await PaymentSettings.findOne();
  const secret = settings?.tagadaWebhookSecret || config.tagadaWebhookSecret;

  if (!secret) {
    console.error('[TagadaPay Webhook] CRITICAL ERROR: Webhook secret is missing (not in DB or .env). Cannot verify signature.');
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  const rawBody: Buffer = (req as any).rawBody ?? req.body;
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

  // Tagada uses a GitHub-style signature format: "sha256=<hex>"
  let receivedHash = signature;
  if (signature.startsWith('sha256=')) {
    receivedHash = signature.replace('sha256=', '');
  }

  // Hash the raw body directly
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  if (receivedHash !== expectedSig) {
    console.warn('\n[TagadaPay Webhook] ❌ SIGNATURE MISMATCH');
    console.warn(` - Received Hash: ${receivedHash}`);
    console.warn(` - Expected Hash: ${expectedSig}`);
    console.warn(` - Using Secret from: ${settings?.tagadaWebhookSecret ? 'Database' : '.env file'}`);
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // 2) Parse payload (rawBody may be a Buffer if using express.raw)
  let payload: TagadaWebhookPayload;
  try {
    const bodyStr =
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    payload = JSON.parse(bodyStr);
  } catch {
    console.error('[TagadaPay Webhook] Invalid JSON body');
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  // The Tagada webhook body IS the raw Payment object directly, not wrapped in { event, data }
  // Extract the webhook type (e.g., 'payment/succeeded', 'order/paid', 'funnel/stepViewed')
  const rawEventType = payload.type || req.headers['x-tagadapay-event'] || 'unknown';
  // Ensure eventType is a string for subsequent checks
  const eventType = Array.isArray(rawEventType) ? (rawEventType[0] ?? '') : (rawEventType ?? '');
  const data = payload.data || payload; // fallback to payload if data is missing
  const dAny = data as any;

  // 4) Ignore events we don't care about
  if (!eventType.startsWith('payment/') && !eventType.startsWith('order/')) {
    console.log(`[TagadaPay Webhook] Ignored non-payment event type: ${eventType}`);
    res.status(200).send(`Ignored event: ${eventType}`);
    return;
  }

  // We originally saved the Checkout Session ID as tagadaPaymentId in MongoDB.
  // Tagada's webhook data object contains checkoutSessionId, paymentId, or orderId depending on the event.
  const tagadaPaymentId = dAny.checkoutSessionId || dAny.paymentId || dAny.orderId || dAny.order_id || 'unknown';
  const tagadaStatus = dAny.status || 'unknown';
  const reference = dAny.reference || dAny.metadata?.order_id || null;

  // ==========================================
  // 🚨 DEVELOPMENT LOGGER - WEBHOOK RECEIVED
  // ==========================================
  console.log('\n\n======================================================');
  console.log(`🛎️  [WEBHOOK RECEIVED] Event: ${eventType}`);
  console.log(`💳  Tagada Payment ID: ${tagadaPaymentId}`);
  console.log(`📊  Status: ${tagadaStatus}`);
  console.log('======================================================');

  console.log('[TagadaPay Webhook] Raw payload:', JSON.stringify(payload, null, 2));

  // 4) Find the matching order
  // We explicitly saved our MongoDB _id as the 'cartToken' during createSession
  const mongoOrderId = dAny.cartToken || dAny.externalOrderId || null;
  const isValidObjectId = (id: any) => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);

  const order = await Order.findOne({
    $or: [
      ...(isValidObjectId(mongoOrderId) ? [{ _id: mongoOrderId }] : []),
      { tagadaPaymentId },
      { tagadaOrderId: dAny.orderId || dAny.order_id },
      ...(isValidObjectId(reference) ? [{ _id: reference }] : []),
      ...(isValidObjectId(payload.metadata?.order_id) ? [{ _id: payload.metadata.order_id }] : []),
      ...(isValidObjectId(dAny.metadata?.order_id) ? [{ _id: dAny.metadata.order_id }] : []),
    ].filter(Boolean),
  });

  if (!order) {
    console.warn(
      `[TagadaPay Webhook] No order found for tagadaId=${tagadaPaymentId} ref=${reference}`
    );
    // Still 200 so Tagada stops retrying
    res.status(200).json({ received: true });
    return;
  }

  const wasAlreadyPaid = order.paymentStatus === 'paid';

  // 4) Map Tagada status → internal status fields
  let inferredStatus = tagadaStatus;
  if (eventType === 'order/paid' || eventType === 'payment/succeeded' || eventType === 'payment/captured') {
    inferredStatus = 'succeeded';
  }

  const newTagadaStatus = inferredStatus as
    | 'initiated'
    | 'authorized'
    | 'captured'
    | 'failed'
    | 'refunded'
    | 'succeeded';
  const newPaymentStatus = mapTagadaStatus(inferredStatus);

  order.tagadaPaymentId = tagadaPaymentId;
  (order as any).tagadaPaymentStatus = newTagadaStatus;
  order.paymentStatus = newPaymentStatus;
  order.paymentMethod = 'tagada';

  // Store Tagada's own order/session IDs
  const tagadaOrderId = dAny.orderId || dAny.order_id;
  const tagadaSessionId = dAny.sessionId || dAny.session_id;

  if (tagadaOrderId) order.tagadaOrderId = tagadaOrderId;
  if (tagadaSessionId) order.tagadaSessionId = tagadaSessionId;

  // 5) On paid — enrich with full order data from Tagada payload
  if (newPaymentStatus === 'paid') {
    order.status = 'processing';
    order.fulfilmentStatus = 'unfulfilled';

    let fullOrder: any = data; // fallback to data if fetch fails or data IS the order
    if (tagadaOrderId) {
      try {
        const client = await getTagadaClient();
        const res = await client.orders.retrieve(tagadaOrderId);
        fullOrder = res.order || res; // Tagada SDK returns { order: { ... } }
        console.log('\n\n======================================================');
        console.log(`[TagadaPay] Fetched full order details for Tagada Order: ${tagadaOrderId}`);
        console.log('======================================================\n\n');
      } catch (err) {
        console.error('[TagadaPay] Failed to fetch full order details:', err);
      }
    }

    // ── Customer snapshot ──────────────────────────────────────────────────────
    if (fullOrder.customer || dAny.user_data) {
      const cust = fullOrder.customer || {};
      order.customer = {
        firstName: cust.firstName ?? cust.first_name ?? '',
        lastName: cust.lastName ?? cust.last_name ?? '',
        email: cust.email ?? dAny.user_data?.email ?? '',
        phone: cust.phone ?? undefined,
      };
      // Backfill legacy fields for any code still reading them
      order.customerEmail = order.customer.email ?? order.customerEmail;
      order.customerName =
        [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ') ||
        order.customerName;
    }

    // ── Shipping address ───────────────────────────────────────────────────────
    const sa = fullOrder.shippingAddress || fullOrder.shipping_address || fullOrder.customer?.shippingAddress;
    if (sa) {
      const saName = sa.name ?? (`${sa.firstName || ''} ${sa.lastName || ''}`.trim() || undefined);
      const saZip = sa.zip ?? sa.postalCode ?? sa.postal ?? undefined;
      order.shippingAddressObj = {
        name: saName,
        company: sa.company ?? undefined,
        street1: sa.address1 ?? sa.line1 ?? undefined,
        street2: sa.address2 ?? sa.line2 ?? undefined,
        city: sa.city ?? undefined,
        state: sa.province ?? sa.state ?? undefined,
        zip: saZip,
        country: sa.country ?? undefined,
      };
      // Backfill legacy string field
      order.shippingAddress = [
        order.shippingAddressObj.street1, order.shippingAddressObj.street2,
        order.shippingAddressObj.city, order.shippingAddressObj.state,
        order.shippingAddressObj.zip, order.shippingAddressObj.country
      ].filter(Boolean).join(', ');
    }

    // ── Billing address ────────────────────────────────────────────────────────
    const ba = fullOrder.billingAddress || fullOrder.billing_address || fullOrder.customer?.billingAddress;
    if (ba) {
      const baName = ba.name ?? (`${ba.firstName || ''} ${ba.lastName || ''}`.trim() || undefined);
      const baZip = ba.zip ?? ba.postalCode ?? ba.postal ?? undefined;
      order.billingAddressObj = {
        name: baName,
        company: ba.company ?? undefined,
        street1: ba.address1 ?? ba.line1 ?? undefined,
        street2: ba.address2 ?? ba.line2 ?? undefined,
        city: ba.city ?? undefined,
        state: ba.province ?? ba.state ?? undefined,
        zip: baZip,
        country: ba.country ?? undefined,
      };
    }

    // ── Line items ─────────────────────────────────────────────────────────────
    const lineItems = fullOrder.items || fullOrder.lineItems || fullOrder.line_items || dAny.lineItems;
    if (lineItems && lineItems.length > 0) {
      order.lineItems = lineItems.map((item: any) => {
        const title = item.orderLineItemProduct?.name ?? item.productName ?? item.name ?? item.title ?? 'Unknown Product';
        const variantTitle = item.orderLineItemVariant?.name ?? item.variantName ?? item.variantTitle ?? item.variant_title ?? undefined;
        const fallbackPrice = Number(item.unitPrice || item.price) || 0;
        let unitPrice = item.unitAmount ? (item.unitAmount / 100) : fallbackPrice;
        const qty = item.quantity || 1;
        const imageUrl = item.orderLineItemVariant?.imageUrl ?? item.imageUrl ?? item.image_url ?? undefined;

        return {
          title,
          variantTitle,
          sku: item.sku ?? undefined,
          quantity: qty,
          unitPrice,
          subtotal: unitPrice * qty,
          productImageUrl: imageUrl,
        };
      });
    }

    // ── Totals ─────────────────────────────────────────────────────────────────
    const summary = fullOrder.summaries?.[0] || {};

    // Subtotal
    if (summary.subtotalAmount !== undefined) order.subtotal = summary.subtotalAmount / 100;
    else if (fullOrder.subtotalAmount !== undefined) order.subtotal = Number(fullOrder.subtotalAmount);
    else if (fullOrder.subtotal_price !== undefined) order.subtotal = Number(fullOrder.subtotal_price);

    // Shipping
    if (summary.shippingCost !== undefined) order.shippingAmount = summary.shippingCost / 100;
    else if (fullOrder.shippingAmount !== undefined) order.shippingAmount = Number(fullOrder.shippingAmount);
    else if (fullOrder.shipping_price !== undefined) order.shippingAmount = Number(fullOrder.shipping_price);

    // Tax
    if (summary.totalTaxAmount !== undefined) order.taxAmount = summary.totalTaxAmount / 100;
    else if (fullOrder.taxAmount !== undefined) order.taxAmount = Number(fullOrder.taxAmount);
    else if (fullOrder.tax_price !== undefined) order.taxAmount = Number(fullOrder.tax_price);

    // Discounts
    let discountAmt = 0;
    if (summary.totalPromotionAmount !== undefined) discountAmt = summary.totalPromotionAmount / 100;
    else if (fullOrder.totalPromotionAmount !== undefined) discountAmt = Number(fullOrder.totalPromotionAmount) / 100;
    else if (fullOrder.discount_price !== undefined) discountAmt = Number(fullOrder.discount_price);

    if (discountAmt > 0) {
      order.discountAmount = discountAmt;
      // Try to find the coupon code
      const adjustments = summary.adjustments || fullOrder.adjustments || [];
      const promoAdjustment = adjustments.find((adj: any) => adj.type === 'Promotion' || adj.description);
      if (promoAdjustment && promoAdjustment.description) {
        order.couponCode = promoAdjustment.description;
      } else if (fullOrder.discount_codes?.length > 0) {
        order.couponCode = fullOrder.discount_codes[0].code;
      }
    }

    // Total
    if (summary.totalAdjustedAmount !== undefined) {
      // Use the final adjusted amount which includes discounts
      order.grandTotal = summary.totalAdjustedAmount / 100;
      order.totalAmount = summary.totalAdjustedAmount / 100;
    } else if (summary.totalAmount !== undefined) {
      order.grandTotal = summary.totalAmount / 100;
      order.totalAmount = summary.totalAmount / 100;
    } else if (fullOrder.totalAmount !== undefined || fullOrder.total_price !== undefined) {
      const tot = Number(fullOrder.totalAmount ?? fullOrder.total_price);
      order.grandTotal = tot;
      order.totalAmount = tot;
    }

    if (summary.currency || fullOrder.currency) {
      order.currency = summary.currency || fullOrder.currency;
    }

    // ── Shipping method ────────────────────────────────────────────────────────
    const firstShipping = fullOrder.shipping_lines?.[0] || fullOrder.shippingLines?.[0];
    if (firstShipping) {
      order.shippingMethodName = firstShipping.title ?? firstShipping.name ?? undefined;
      order.shippingMethodCode = firstShipping.code ?? undefined;
    } else if (fullOrder.checkoutSession?.shippingRateId) {
      order.shippingMethodCode = fullOrder.checkoutSession.shippingRateId;
      order.shippingMethodName = 'Standard Shipping'; // Fallback if Tagada SDK doesn't provide the string
    }

    // ── Tags (Tagada IDs) ──────────────────────────────────────────────────────
    const existingTags: string[] = (order.tags as string[]) ?? [];
    const newTags: string[] = fullOrder.tags ?? [];
    // Append any Tagada IDs for display in the admin list
    if (tagadaOrderId && !existingTags.includes(tagadaOrderId)) newTags.push(tagadaOrderId);
    if (tagadaPaymentId && !existingTags.includes(tagadaPaymentId)) newTags.push(tagadaPaymentId);
    order.tags = Array.from(new Set([...existingTags, ...newTags]));

    // ── Generate human-readable order number ───────────────────────────────────
    if (!order.orderNumber) {
      order.orderNumber = await generateOrderNumber();
    }

    order.deliveryStatus = 'pending';

    console.log(
      `[TagadaPay] Order ${order._id} PAID → orderNumber=${order.orderNumber}, status=processing`
    );

    if (!wasAlreadyPaid) {
      try {
        await sendOrderConfirmationEmail(order);
        console.log(`[Email] Order confirmation sent for ${order.orderNumber}`);
      } catch (error) {
        console.error(`[Email] Failed to send order confirmation for ${order.orderNumber}:`, error);
      }

      // Upsert Customer Record
      if (order.customerEmail) {
        try {
          const customerName = order.customerName || (order.customer ? `${order.customer.firstName} ${order.customer.lastName}`.trim() : 'Unknown Customer');
          const customerCountry = order.shippingAddressObj?.country || order.billingAddressObj?.country || '';

          await Customer.findOneAndUpdate(
            { email: order.customerEmail },
            {
              $set: {
                name: customerName,
                country: customerCountry,
                defaultAddress: order.shippingAddressObj || undefined,
              },
              $inc: {
                orderCount: 1,
                totalSpent: order.grandTotal || 0,
              }
            },
            { upsert: true, new: true }
          );
          console.log(`[Customer] Upserted CRM record for ${order.customerEmail}`);
        } catch (error) {
          console.error(`[Customer] Failed to upsert CRM record:`, error);
        }
      }
    }
  }

  if (newPaymentStatus === 'failed') {
    console.log(`[TagadaPay] Order ${order._id} FAILED`);
    // TODO: Release reserved stock
  }

  if (newPaymentStatus === 'refunded' || eventType === 'payment/partially_refunded' || eventType.includes('refund')) {
    console.log(`[TagadaPay] Order ${order._id} REFUND EVENT (${eventType})`);
    
    // We assume Tagada webhook provides the refunded amount in `payload.data.amount_refunded` or similar.
    // If not, we will rely on what was initiated.
    const refundedAmount = dAny.amount_refunded || dAny.refundedAmount || dAny.amount || 0;
    
    // Update the pending Refund record (if any exists for this order)
    try {
      const pendingRefund = await Refund.findOne({ order: order._id, status: 'pending' });
      if (pendingRefund) {
        pendingRefund.status = 'succeeded';
        // Tagada's refund ID might be in the payload
        pendingRefund.tagadaRefundId = dAny.id || dAny.refund_id || pendingRefund.tagadaRefundId;
        await pendingRefund.save();
      } else {
        // If no pending refund is found, it means the refund was initiated directly from Tagada Dashboard
        await Refund.create({
          order: order._id,
          amount: refundedAmount,
          reason: 'Initiated from Tagada Dashboard',
          type: newPaymentStatus === 'refunded' ? 'full' : 'partial',
          status: 'succeeded',
          tagadaRefundId: dAny.id || dAny.refund_id
        });
      }
    } catch (err) {
      console.error('[TagadaPay Webhook] Failed to update Refund record:', err);
    }

    if (newPaymentStatus === 'refunded') {
      order.refundStatus = 'refunded';
      order.refundedAmount = order.grandTotal || refundedAmount;
    } else {
      order.refundStatus = 'partially_refunded';
      // accumulate the refunded amount
      order.refundedAmount = (order.refundedAmount || 0) + refundedAmount;
    }
  }

  try {
    await order.save({ validateBeforeSave: false });
  } catch (err: any) {
    if (err.name === 'VersionError') {
      console.warn(`[TagadaPay Webhook] Version conflict for order ${order._id}. Ignored as another webhook likely processed it.`);
    } else {
      throw err; // Let catchAsync handle it and send a 500 so Tagada retries
    }
  }

  // Always respond 200 to prevent Tagada from retrying
  res.status(200).json({ received: true });
});

// ─── 3. Test TagadaPay Connection ─────────────────────────────────────────────

/**
 * GET /api/admin/settings/tagada/test
 *
 * Makes a lightweight authenticated request to TagadaPay to verify
 * the current credentials are valid. Used by the admin settings UI.
 */
export const testTagadaConnection = catchAsync(
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const axios = require('axios').default;
      // Use a lightweight endpoint — list payments with limit 1
      const env = config.tagadaEnv;
      const apiKey = env === 'prod' ? config.tagadaApiKeyProd : config.tagadaApiKeySandbox;
      const baseUrl = env === 'prod' ? 'https://app.tagadapay.com/api/public/v1' : 'https://app.tagadapay.dev/api/public/v1';

      await axios.get(`${baseUrl}/payments`, {
        params: { limit: 1 },
        headers: { Authorization: `Bearer ${apiKey}` }
      });

      res.status(200).json({
        success: true,
        message: `TagadaPay connection successful (env: ${config.tagadaEnv})`,
        env: config.tagadaEnv,
      });
    } catch (err: any) {
      const status = err?.response?.status ?? 502;
      const message =
        err?.response?.data?.message ??
        'TagadaPay connection failed — check your API key and environment';
      console.error('[TagadaPay Test] Connection error:', err?.response?.data ?? err.message);
      return next(new AppError(message, status));
    }
  }
);
