import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Order from '../models/order.model';
import Product from '../models/product.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import { withOrderNumberRetry } from '../services/orders/orderNumber';
import { resolveCheckoutLines, CheckoutValidationError } from '../services/orders/checkoutItems';
import { sendShipmentConfirmationEmail } from '../services/emailService';
import { isStaffRole } from '../config/roles';

const MAX_ITEM_QUANTITY = 100;
const MAX_ORDER_LINES = 50;

/**
 * Place a new Order.
 * Resolves prices from Database (client prices are not trusted) and aggregates total amount.
 */
export const createOrder = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { products, shippingAddress, customerEmail, customerName, paymentMethod } = req.body;

  if (!products || !Array.isArray(products) || products.length === 0) {
    return next(new AppError('Please provide a list of products for your order.', 400));
  }
  if (products.length > MAX_ORDER_LINES) {
    return next(new AppError(`An order may contain at most ${MAX_ORDER_LINES} lines.`, 400));
  }
  for (const item of products) {
    const productId = item?.product;
    if (typeof productId !== 'string' || !mongoose.Types.ObjectId.isValid(productId) || !/^[a-f0-9]{24}$/i.test(productId)) {
      return next(new AppError('Invalid product ID in order.', 400));
    }
    const q = item.quantity === undefined ? 1 : item.quantity;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > MAX_ITEM_QUANTITY) {
      return next(new AppError(`Item quantity must be a whole number between 1 and ${MAX_ITEM_QUANTITY}.`, 400));
    }
  }

  // Address collected via Tagada hosted checkout

  // 1) Resolve products/variants, prices and stock server-side — same resolver as createTagadaPayment (M-11)
  let lines;
  try {
    lines = await resolveCheckoutLines(
      products.map((p: any) => ({ ...p, variantId: p.variantId ?? p.variant })),
      (id) => Product.findById(id)
    );
  } catch (err) {
    if (err instanceof CheckoutValidationError) return next(new AppError(err.message, 400));
    throw err;
  }
  const orderItems = lines.map((l) => ({
    product: l.product,
    variant: l.variant,
    tagadaVariantId: l.tagadaVariantId,
    variantTitle: l.variantTitle,
    quantity: l.quantity,
    price: l.price,
  }));
  const totalAmount = Math.round(lines.reduce((sum, l) => sum + l.price * l.quantity, 0) * 100) / 100;

  // 2) Create the order document (retry on orderNumber collision)
  // Per-order secret for guest order lookups (GET /api/v1/orders/:id?accessToken=...).
  const publicAccessToken = crypto.randomBytes(32).toString('hex');
  const newOrder = await withOrderNumberRetry((orderNumber) =>
    Order.create({
      orderNumber,
      publicAccessToken,
      user: req.user?._id,
      products: orderItems,
      totalAmount,
      shippingAddress,
      customerEmail: customerEmail || '',
      customerName: customerName || '',
      paymentMethod: paymentMethod || undefined,
    })
  );

  const orderJson: any = newOrder.toObject();
  orderJson.publicAccessToken = publicAccessToken;

  res.status(201).json({
    success: true,
    data: {
      order: orderJson,
      accessToken: publicAccessToken,
    },
  });
});

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
    shippingAddressObj: { name: ship.name, city: ship.city, country: ship.country },
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

    let hasChanges = false;
    let isNewlyShipped = false;

    if (actualPayload.tracking_number && order.trackingNumber !== actualPayload.tracking_number) {
      order.trackingNumber = actualPayload.tracking_number;
      hasChanges = true;
    }

    if (actualPayload.tracking_status && order.shipmentStatus !== actualPayload.tracking_status) {
      order.shipmentStatus = actualPayload.tracking_status;
      hasChanges = true;
      const statusLower = actualPayload.tracking_status.toLowerCase();
      if (statusLower === 'dispatched' || statusLower === 'shipped' || statusLower === 'printed') {
        if (order.status !== 'shipped' || order.fulfilmentStatus !== 'fulfilled') {
          order.status = 'shipped';
          order.fulfilmentStatus = 'fulfilled';
          order.shippedAt = new Date();
          isNewlyShipped = true;
        }
      }
    }

    const newCarrier = actualPayload.carrier_name || actualPayload.carrier;
    if (newCarrier && order.trackingCarrier !== newCarrier) {
      order.trackingCarrier = newCarrier;
      hasChanges = true;
    }

    if (hasChanges) {
      // Auto-generate generic tracking URL if we have a tracking number but no URL
      if (order.trackingNumber && !order.trackingUrl) {
        const carrier = order.trackingCarrier || '';
        if (carrier.toLowerCase().includes('auspost') || carrier.toLowerCase().includes('australia post')) {
          order.trackingUrl = `https://auspost.com.au/mypost/track/#/details/${order.trackingNumber}`;
        } else {
          order.trackingUrl = `https://www.google.com/search?q=${order.trackingNumber}`;
        }
      }
      
      await order.save();
      console.log(`Starshipit Webhook: Updated order ${actualPayload.order_number} to status ${actualPayload.tracking_status}`);

      if (isNewlyShipped) {
        sendShipmentConfirmationEmail(order).catch(err => console.error('Failed to send shipment email via webhook:', err));
      }
    } else {
      console.log(`Starshipit Webhook: Ignored non-changing update for order ${actualPayload.order_number}`);
    }
  } catch (error) {
    console.error('Starshipit Webhook Processing Error:', error);
  }
});
