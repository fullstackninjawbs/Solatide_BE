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
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import config from '../config';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TagadaPaymentResponse {
  id: string;
  status: string;
  checkoutUrl?: string;
  clientToken?: string;
  reference?: string;
}

interface TagadaWebhookPayload {
  event: string;
  data: {
    id: string;           // TagadaPay payment id
    status: string;       // authorized | captured | failed | refunded | created
    reference?: string;   // orderId we sent in /create
    amount?: number;
    currency?: string;
  };
}

// ─── Helper: map Tagada status → internal paymentStatus ──────────────────────

function mapTagadaStatus(tagadaStatus: string): 'pending' | 'paid' | 'failed' | 'refunded' {
  switch (tagadaStatus) {
    case 'authorized':
    case 'captured':
      return 'paid';
    case 'failed':
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

    // 1) Load order — populate user for email/name
    const order = await Order.findById(orderId).populate('user', 'name email');

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

    // 4) Build Tagada payload using the Node SDK
    // Map order products to Tagada's items array: { variantId, quantity }
    const items = order.products.map((item: any) => {
      // Assuming single variant products or defaulting to the root tagadaVariantId
      const variantId = item.product?.tagadaVariantId || item.product?.variants?.[0]?.tagadaVariantId || 'missing_variant_id';
      
      if (variantId === 'missing_variant_id') {
        throw new AppError(`Product "${item.product?.name || 'Unknown'}" does not have a Tagada Variant ID configured. Please update your database products to include 'tagadaVariantId'.`, 400);
      }

      return {
        variantId,
        quantity: item.quantity,
      };
    });

    // 5) Call TagadaPay SDK to create session
    let session: any;
    try {
      const client = await getTagadaClient();
      session = await client.checkout.createSession({
        storeId: config.tagadaStoreId,
        items,
        currency: order.currency || config.tagadaDefaultCurrency,
        checkoutUrl: config.tagadaCheckoutUrl,
        metadata: { 
          orderId: order._id.toString(),
          accountId: config.tagadaAccountId,
        },
      });
    } catch (err: any) {
      console.error('[TagadaPay SDK] createSession error:', err?.response?.data ?? err.message);
      const status = err?.response?.status ?? 502;
      const message =
        err?.response?.data?.message ?? err.message ?? 'TagadaPay session creation failed';
      return next(new AppError(message, status));
    }

    // 6) Persist Tagada session id on the order
    order.tagadaPaymentId = session.id;
    order.tagadaPaymentStatus = 'initiated';
    order.paymentMethod = 'tagada';
    // paymentStatus stays 'pending' — webhook will flip it to 'paid'
    await order.save({ validateBeforeSave: false });

    console.log(
      `[TagadaPay] Session created | orderId=${orderId} | sessionId=${session.id}`
    );

    // 7) Return redirect URL to frontend
    res.status(200).json({
      success: true,
      paymentId: session.id,
      status: 'initiated',
      checkoutUrl: session.redirectUrl ?? null,
      clientToken: null, // Removed in SDK v2 approach
    });
  }
);

// ─── 2. TagadaPay Webhook ─────────────────────────────────────────────────────

/**
 * POST /api/payments/tagada/webhook
 *
 * Receives async payment status updates from TagadaPay.
 * No auth middleware — Tagada must be able to reach this endpoint.
 * Signature is verified via HMAC-SHA256 before processing.
 *
 * NOTE: This route must receive the raw body buffer (not parsed JSON).
 * Register it in server.ts BEFORE the global express.json() middleware,
 * or use express.raw() on this route specifically.
 */
export const tagadaWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // 1) Verify signature
  const signature = req.headers['x-tagada-signature'] as string | undefined;

  if (!signature) {
    console.warn('[TagadaPay Webhook] Missing x-tagada-signature header');
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  const secret = config.tagadaWebhookSecret;
  const rawBody: Buffer = (req as any).rawBody ?? req.body;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  if (signature !== expectedSig) {
    console.warn('[TagadaPay Webhook] Signature mismatch — rejecting request');
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

  const { event, data } = payload;
  const { id: tagadaPaymentId, status: tagadaStatus, reference } = data;

  console.log(
    `[TagadaPay Webhook] event=${event} | tagadaId=${tagadaPaymentId} | status=${tagadaStatus} | ref=${reference}`
  );

  // 3) Find matching order
  const order = await Order.findOne({
    $or: [
      { tagadaPaymentId },
      ...(reference ? [{ _id: reference }] : []),
    ],
  });

  if (!order) {
    // Log anomaly but respond 200 so Tagada stops retrying
    console.warn(
      `[TagadaPay Webhook] No order found for tagadaId=${tagadaPaymentId} ref=${reference}`
    );
    res.status(200).json({ received: true });
    return;
  }

  // 4) Map Tagada status → internal fields
  const newTagadaStatus = tagadaStatus as
    | 'initiated'
    | 'authorized'
    | 'captured'
    | 'failed'
    | 'refunded';
  const newPaymentStatus = mapTagadaStatus(tagadaStatus);

  order.tagadaPaymentStatus = newTagadaStatus;
  order.paymentStatus = newPaymentStatus;

  // 5) Side effects per status
  if (newPaymentStatus === 'paid') {
    // Advance order status so the shipping/label flow can pick it up
    order.status = 'processing';
    // TODO: Trigger order confirmation email (plug in nodemailer / SendGrid here)
    console.log(`[TagadaPay] Order ${order._id} PAID — status → processing, trigger confirmation email`);
    // TODO: Mark stock as finally sold (if using stock reservation)
  }

  if (newPaymentStatus === 'failed') {
    console.log(`[TagadaPay] Order ${order._id} FAILED — keeping order, marked failed`);
    // TODO: Release reserved stock
  }

  if (newPaymentStatus === 'refunded') {
    // TODO: Trigger refund confirmation email
    console.log(`[TagadaPay] Order ${order._id} REFUNDED — trigger refund email`);
  }

  await order.save({ validateBeforeSave: false });

  // 6) Always respond 200 to prevent Tagada retries
  res.status(200).json({ received: true });
};

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
