import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Order from '../models/order.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import { applyStarshipitTrackingUpdate } from '../services/shipping/starshipitTracking';
import { isStaffRole } from '../config/roles';

/**
 * Get all orders placed by the authenticated user
 */
export const getMyOrders = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const orders = await Order.find({ user: req.user!._id });

  res.status(200).json({
    success: true,
    results: orders.length,
    data: {
      orders,
    },
  });
});

/**
 * Get all orders in system (Admin Only)
 */
export const getAllOrders = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const orders = await Order.find();

  res.status(200).json({
    success: true,
    results: orders.length,
    data: {
      orders,
    },
  });
});

/**
 * Update order status (Admin Only)
 */
export const updateOrderStatus = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { status } = req.body;

  if (!status) {
    return next(new AppError('Please provide an order status', 400));
  }

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true }
  );

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  res.status(200).json({
    success: true,
    data: {
      order,
    },
  });
});

/**
 * Minimal public view of an order (no email/phone/street address/attribution/notes).
 */
export const toPublicOrder = (order: any) => {
  const o = typeof order?.toObject === 'function' ? order.toObject() : order;
  const ship = o.shippingAddressObj || {};
  return {
    _id: o._id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    fulfilmentStatus: o.fulfilmentStatus,
    deliveryStatus: o.deliveryStatus,
    refundStatus: o.refundStatus,
    currency: o.currency,
    paymentMethod: o.paymentMethod,
    lineItems: (o.lineItems || []).map((li: any) => ({
      title: li.title,
      variantTitle: li.variantTitle,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      subtotal: li.subtotal,
      productImageUrl: li.productImageUrl,
    })),
    products: (o.products || []).map((p: any) => ({
      product: p.product,
      name: p.name ?? p.product?.name,
      quantity: p.quantity,
      price: p.price,
    })),
    subtotal: o.subtotal,
    shippingAmount: o.shippingAmount,
    taxAmount: o.taxAmount,
    discountAmount: o.discountAmount,
    grandTotal: o.grandTotal,
    totalAmount: o.totalAmount,
    shippingMethodName: o.shippingMethodName,
    shippingAddressObj: { name: ship.name, city: ship.city, state: ship.state, country: ship.country },
    trackingNumber: o.trackingNumber,
    trackingCarrier: o.trackingCarrier,
    trackingUrl: o.trackingUrl,
    shipmentStatus: o.shipmentStatus,
    shippedAt: o.shippedAt,
    createdAt: o.createdAt,
  };
};

const safeEqualStrings = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

/**
 * Get a single order by ID.
 * Access: the authenticated owner, a staff user, or a guest presenting the
 * order's `publicAccessToken` as ?accessToken=. Non-staff get a minimal projection.
 * Unauthorised lookups return 404 (no existence oracle).
 */
export const getOrderById = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError('No order found with that ID', 404));
  }

  const order: any = await Order.findById(id).select('+publicAccessToken');
  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  const user = req.user;
  const isStaff = !!user && isStaffRole(user.role);
  const isOwner = !!user && !!order.user && String(order.user) === String(user._id);

  const provided = typeof req.query.accessToken === 'string' ? req.query.accessToken : '';
  const stored: string = typeof order.publicAccessToken === 'string' ? order.publicAccessToken : '';
  const tokenOk = !!provided && !!stored && provided.length <= 256 && safeEqualStrings(provided, stored);

  if (!isStaff && !isOwner && !tokenOk) {
    return next(new AppError('No order found with that ID', 404));
  }

  if (isStaff) {
    const full = order.toObject();
    delete full.publicAccessToken;
    return res.status(200).json({ success: true, data: { order: full } });
  }

  res.status(200).json({
    success: true,
    data: {
      order: toPublicOrder(order),
    },
  });
});

/**
 * Starshipit webhook authentication: shared secret (env STARSHIPIT_WEBHOOK_SECRET)
 * via `x-starshipit-secret` header or `?token=` query. Fails closed (503) when the
 * secret is not configured.
 */
let warnedStarshipitSecretMissing = false;
export const verifyStarshipitWebhook = (req: Request, res: Response, next: NextFunction) => {
  const expected = process.env.STARSHIPIT_WEBHOOK_SECRET || '';
  if (!expected) {
    if (!warnedStarshipitSecretMissing) {
      warnedStarshipitSecretMissing = true;
      console.error('[Starshipit Webhook] STARSHIPIT_WEBHOOK_SECRET is not set — rejecting all webhook calls.');
    }
    return res.status(503).json({ success: false, message: 'Webhook not configured' });
  }

  const header = req.headers['x-starshipit-secret'];
  const provided =
    (typeof header === 'string' && header) ||
    (typeof req.query.token === 'string' && req.query.token) ||
    '';

  // Compare fixed-length digests so neither content nor length leaks via timing
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!provided || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

/**
 * Handle incoming webhooks from Starshipit to sync tracking details
 * Webhook sends data like: { order_number: '1004', reference: 'ORD-123', tracking_number: '...', carrier: '...', status: 'Dispatched' }
 */
export const handleStarshipitWebhook = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const payload = req.body;
  
  // Acknowledge receipt immediately to Starshipit
  res.status(200).json({ received: true });

  // Sometimes Starshipit nests the payload under an 'order' object
  const actualPayload = payload && payload.order ? payload.order : payload;

  if (!actualPayload || !actualPayload.order_number) {
    console.warn('Starshipit Webhook: Invalid payload (missing order_number)');
    return;
  }

  try {
    const order = await Order.findOne({ orderNumber: actualPayload.order_number });
    if (!order) {
      console.warn(`Starshipit Webhook: Order ${actualPayload.order_number} not found in database.`);
      return;
    }

    const { changed } = await applyStarshipitTrackingUpdate(order, actualPayload);
    if (changed) {
      console.log(`Starshipit Webhook: Updated order ${actualPayload.order_number} to status ${actualPayload.tracking_status}`);
    } else {
      console.log(`Starshipit Webhook: Ignored non-changing update for order ${actualPayload.order_number}`);
    }
  } catch (error) {
    console.error('Starshipit Webhook Processing Error:', error);
  }
});
