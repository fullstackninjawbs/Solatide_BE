import { Request, Response, NextFunction } from 'express';
import Order from '../../models/order.model';
import Product from '../../models/product.model';
import StoreSettings from '../../models/StoreSettings';
import { starshipitService } from '../../services/shipping/starshipit.service';
import { sendShipmentConfirmationEmail, sendOrderConfirmationEmail, sendAdminNewOrderNotificationEmail } from '../../services/emailService';
import AppError from '../../utils/appError';
import catchAsync from '../../utils/catchAsync';
import { getTagadaClient } from '../../services/tagadaClient';
import config from '../../config';
import Refund from '../../models/Refund';
import Customer from '../../models/Customer';
import AddressValidationService from '../../services/addressValidation.service';
import axios from 'axios';
import { starshipitRequest } from '../../services/shipping/starshipitHttp';
import { PAYMENT_STATUSES, PaymentStatus } from '../../domain/orderTransitions';
import { validateRefundRequest, refundsEnabled, toMinorUnits } from '../../domain/money';
import { withTimeout, TAGADA_TIMEOUT_MS } from '../../domain/withTimeout';
import { isUsableExternalId } from '../../domain/tagadaWebhook';
import { generateOrderAccessToken } from '../../domain/orderAccess';
import { transitionPaymentStatus } from '../../services/orders/paymentTransition';
import { scheduleOnOrderPaid } from '../../services/orders/onOrderPaid';
import { syncOrderFromTagada, pickTagadaLookupId } from '../../services/orders/tagadaSync';
import { withOrderNumberRetry } from '../../services/orders/orderNumber';
import { reserveRefund, releaseRefund, confirmReservedRefund, refundTargetStatus, extractRefundId } from '../../services/orders/refunds';
import { decrementLineForOrder } from '../../services/orders/inventory';
import { parseQuantity, CheckoutValidationError, MAX_LINE_QUANTITY } from '../../services/orders/checkoutItems';

const STARSHIPIT_TIMEOUT_MS = 15000;

/**
 * GET /api/admin/orders
 *
 * Paginated, filterable list of all orders.
 * Query params:
 *   status            - pending | processing | shipped | delivered | cancelled
 *   paymentStatus     - pending | paid | failed | refunded
 *   fulfilmentStatus  - unfulfilled | fulfilled | partial
 *   q                 - search by orderNumber or customer.email
 *   page              - 1-indexed page number (default: 1)
 *   limit             - results per page (default: 50)
 */
export const getOrders = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const {
    status,
    paymentStatus,
    fulfilmentStatus,
    q,
    page = '1',
    limit = '50',
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * limitNum;

  // Build filter
  const filter: Record<string, any> = {};

  if (req.query.hasCustomer === 'true') {
    filter.$or = [
      { customerName: { $nin: ['', null] } },
      { customerEmail: { $nin: ['', null] } },
      { 'customer.firstName': { $nin: ['', null] } }
    ];
  } else if (req.query.hasCustomer === 'false') {
    filter.$and = [
      { customerName: { $in: ['', null] } },
      { customerEmail: { $in: ['', null] } },
      { 'customer.firstName': { $in: ['', null] } }
    ];
  }

  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (fulfilmentStatus) filter.fulfilmentStatus = fulfilmentStatus;

  // Handle deleted orders toggle
  if (req.query.isDeleted === 'true') {
    filter.isDeleted = true;
  } else {
    filter.isDeleted = { $ne: true };
  }

  // Text search across orderNumber and customer.email
  if (q && q.trim()) {
    const escapedQ = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchFilter = {
      $or: [
        { orderNumber: { $regex: escapedQ, $options: 'i' } },
        { 'customer.email': { $regex: escapedQ, $options: 'i' } },
        { customerEmail: { $regex: escapedQ, $options: 'i' } },
        { customerName: { $regex: escapedQ, $options: 'i' } },
      ]
    };

    if (filter.$and) {
      filter.$and.push(searchFilter);
    } else if (filter.$or) {
      const existingOr = filter.$or;
      delete filter.$or;
      filter.$and = [{ $or: existingOr }, searchFilter];
    } else {
      filter.$or = searchFilter.$or;
    }
  }

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Order.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    results: orders.length,
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum),
    data: {
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    },
  });
});

/**
 * GET /api/admin/orders/:id
 *
 * Full order detail — returns all fields.
 */
export const getOrderById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  let order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  // Automatically trigger address validation on first view if not yet checked
  if (!order.addressValidation?.checkedAt && order.shippingAddressObj && order.shippingAddressObj.street1) {
    try {
      await AddressValidationService.validateOrderAddress(order._id);
      // Re-fetch the updated order document
      const updatedOrder = await Order.findById(req.params.id);
      if (updatedOrder) {
        order = updatedOrder;
      }
    } catch (err) {
      console.error(`[getOrderById] Failed to validate order address for ${order._id}:`, err);
    }
  }

  // If the order is still pending, proactively check TagadaPay for the latest status.
  // Uses the guarded transition and the idempotent onOrderPaid side effects (H-4/H-5).
  if (order.paymentStatus === 'pending' && order.paymentMethod === 'tagada' && pickTagadaLookupId(order)) {
    try {
      const result = await syncOrderFromTagada(order._id, { timeoutMs: 8000 });
      if (result.order) order = result.order;
      if (result.becamePaid) scheduleOnOrderPaid(req.params.id);
    } catch (err: any) {
      console.error(`[getOrderById] Auto-sync failed for pending Tagada order ${req.params.id}: ${err?.message}`);
    }
  }

  res.status(200).json({
    success: true,
    data: { order: order?.toObject ? order.toObject() : order },
  });
});

/**
 * PATCH /api/admin/orders/:id/status
 *
 * Update status and/or fulfilmentStatus on an order.
 * Body: { status?, fulfilmentStatus?, adminNotes? }
 */
export const updateOrderStatus = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { status, fulfilmentStatus, paymentStatus, adminNotes } = req.body;

  const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  const validFulfilment = ['unfulfilled', 'fulfilled', 'partial'];
  const validPaymentStatuses: string[] = PAYMENT_STATUSES;

  if (status && !validStatuses.includes(status)) {
    return next(new AppError(`Invalid status: ${status}`, 400));
  }
  if (fulfilmentStatus && !validFulfilment.includes(fulfilmentStatus)) {
    return next(new AppError(`Invalid fulfilmentStatus: ${fulfilmentStatus}`, 400));
  }
  if (paymentStatus && !validPaymentStatuses.includes(paymentStatus)) {
    return next(new AppError(`Invalid paymentStatus: ${paymentStatus}`, 400));
  }

  const updateFields: Record<string, any> = {};
  if (status) updateFields.status = status;
  if (fulfilmentStatus) updateFields.fulfilmentStatus = fulfilmentStatus;
  if (adminNotes !== undefined) updateFields.adminNotes = String(adminNotes).slice(0, 5000);

  if (Object.keys(updateFields).length === 0 && !paymentStatus) {
    return next(new AppError('No valid fields to update', 400));
  }

  const existing = await Order.findById(req.params.id).select('_id paymentStatus').lean();
  if (!existing) {
    return next(new AppError('No order found with that ID', 404));
  }

  // Payment status goes through the forward-only guard (H-5).
  let becamePaid = false;
  if (paymentStatus && paymentStatus !== existing.paymentStatus) {
    const t = await transitionPaymentStatus(existing._id, paymentStatus as PaymentStatus);
    if (t.result === 'rejected') {
      return next(new AppError(`Cannot change payment status: ${t.reason}`, 409));
    }
    becamePaid = paymentStatus === 'paid' && t.result === 'applied';
  }

  let order: any;
  if (Object.keys(updateFields).length > 0) {
    order = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true, runValidators: true }
    ).lean();
  } else {
    order = await Order.findById(req.params.id).lean();
  }

  if (becamePaid) scheduleOnOrderPaid(existing._id);

  res.status(200).json({
    success: true,
    data: { order },
  });
});

/**
 * PATCH /api/admin/orders/:id
 *
 * Update order details including tags, comments, addresses.
 */
export const updateOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { tags, comments, shippingAddressObj, billingAddressObj, adminNotes, skipRevalidation } = req.body;

  const updateFields: Record<string, any> = {};
  if (tags !== undefined) updateFields.tags = tags;
  if (comments !== undefined) updateFields.comments = comments;
  if (shippingAddressObj !== undefined) {
    updateFields.shippingAddressObj = shippingAddressObj;
    // Clear the address validation warning when admin manually updates shipping address
    updateFields['addressValidation.needsReview'] = false;
  }
  if (billingAddressObj !== undefined) updateFields.billingAddressObj = billingAddressObj;
  if (adminNotes !== undefined) updateFields.adminNotes = adminNotes;

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { $set: updateFields },
    { new: true, runValidators: true }
  ).lean();

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  if (shippingAddressObj !== undefined) {
    if (skipRevalidation) {
      // Admin explicitly accepted a suggested address — trust it, just clear the flag fully
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            'addressValidation.needsReview': false,
            'addressValidation.validationMessage': '',
            'addressValidation.status': 'confirmed'
          },
          $unset: { 'addressValidation.suggestedAddress': '' }
        }
      );
      const reFetched = await Order.findById(order._id).lean();
      if (reFetched) Object.assign(order, reFetched);
    } else {
      try {
        await Order.updateOne({ _id: order._id }, { $unset: { addressValidation: '' } });
        await AddressValidationService.validateOrderAddress(order._id);
        const reFetched = await Order.findById(order._id).lean();
        if (reFetched) Object.assign(order, reFetched);
      } catch (err) {
        console.error('[Admin Order] Validation error during update:', err);
      }
    }
  }

  res.status(200).json({
    success: true,
    data: { order },
  });
});

/**
 * POST /api/admin/orders/:id/shipment
 *
 * Create an EasyPost shipment and purchase the lowest rate label.
 */
export const createShipment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  // ─── If order is already in Starshipit, skip import and try to pull latest details / generate label ───
  if (order.starshipitOrderId) {
    const starshipitOrderId = order.starshipitOrderId;
    try {
      // Try to generate the label (idempotent — Starshipit ignores if already generated)
      let trackingNumber = order.trackingNumber || '';
      let trackingCarrier = order.trackingCarrier || '';
      let labelUrl = order.labelUrl || '';
      let trackingUrl = order.trackingUrl || '';
      let shipmentStatus = order.shipmentStatus || 'Order Created in Starshipit';
      let warning: string | undefined;

      try {
        const axios = require('axios');
        const headers = {
          'StarShipIT-Api-Key': process.env.STARSHIPIT_API_KEY || '',
          'Ocp-Apim-Subscription-Key': process.env.STARSHIPIT_SUBSCRIPTION_KEY || '',
          'Content-Type': 'application/json'
        };
        const labelResponse = await starshipitRequest(
          'post',
          'https://api.starshipit.com/api/orders/shipment',
          { order_id: parseInt(starshipitOrderId) },
          { headers, timeout: STARSHIPIT_TIMEOUT_MS },
          { repeatable: true }
        );
        if (labelResponse.data && labelResponse.data.success !== false) {
          const shippedOrder = labelResponse.data?.order || labelResponse.data?.orders?.[0];
          if (shippedOrder) {
            trackingNumber = trackingNumber || shippedOrder.tracking_number || '';
            trackingCarrier = trackingCarrier || shippedOrder.carrier || '';
            labelUrl = shippedOrder.label_url || shippedOrder.pdf_url || shippedOrder.tracking_url || labelUrl;
            shipmentStatus = trackingNumber ? 'Label Generated' : shipmentStatus;
          }
        }
      } catch (labelErr: any) {
        warning = `Label generation pending in Starshipit — check dashboard`;
        console.warn(`Label generation attempt failed (already imported) for order ${order.orderNumber ?? order._id}: ${labelErr.response?.status ?? ''} ${labelErr.message}`);
      }

      // Always do a fresh getShipmentDetails to sync any new tracking data
      try {
        const details = await starshipitService.getShipmentDetails(starshipitOrderId);
        trackingNumber = trackingNumber || details.trackingNumber || '';
        trackingCarrier = trackingCarrier || details.trackingCarrier || '';
        labelUrl = labelUrl || details.labelUrl || '';
        trackingUrl = trackingUrl || details.trackingUrl || '';
        if (details.shipmentStatus && details.shipmentStatus !== '') shipmentStatus = details.shipmentStatus;
      } catch (detailsErr: any) {
        console.warn('getShipmentDetails failed for existing order:', detailsErr.message);
      }

      // Build tracking URL if still missing
      if (!trackingUrl && trackingNumber && trackingCarrier) {
        const cl = trackingCarrier.toLowerCase();
        if (cl.includes('australia post') || cl.includes('auspost') || cl.includes('mypost')) {
          trackingUrl = `https://auspost.com.au/mypost/track/#/details/${trackingNumber}`;
        } else {
          trackingUrl = `https://www.google.com/search?q=${trackingNumber}`;
        }
      }

      if (trackingNumber) order.trackingNumber = trackingNumber;
      if (trackingCarrier) order.trackingCarrier = trackingCarrier;
      if (labelUrl) order.labelUrl = labelUrl;
      if (trackingUrl) order.trackingUrl = trackingUrl;
      order.shipmentStatus = trackingNumber ? 'Label Generated' : (shipmentStatus || 'Order Created in Starshipit (Label Pending)');
      if (trackingNumber) { order.status = 'shipped'; order.shippedAt = new Date(); }

      await order.save();

      if (trackingNumber && !order.trackingNumber) {
        sendShipmentConfirmationEmail(order).catch(err => console.error('Failed to send shipment email:', err));
      }

      return res.status(200).json({
        success: true,
        message: warning
          ? `Order already in Starshipit (ID: ${starshipitOrderId}). Note: ${warning}`
          : `Shipment details refreshed from Starshipit (ID: ${starshipitOrderId})`,
        data: { order }
      });
    } catch (err: any) {
      return next(new AppError(err.message || 'Failed to refresh shipment from Starshipit', 500));
    }
  }

  if (!order.shippingAddressObj) {
    return next(new AppError('Order missing shipping address', 400));
  }

  const isManual = order.source === 'admin_manual';

  if (!isManual && (order.paymentStatus === 'pending' || order.tagadaPaymentStatus === 'pending')) {
    return next(new AppError('Cannot create shipment: Payment is still pending', 400));
  }

  if (order.addressValidation?.needsReview) {
    return next(new AppError('Cannot create shipment: Shipping address needs review and must be verified first', 400));
  }

  // Get Store Settings for 'From' address
  const settings = await StoreSettings.findOne();
  if (!settings || !settings.shippingOrigin) {
    return next(new AppError('Store shipping origin address not configured in settings', 400));
  }

  if (!process.env.STARSHIPIT_API_KEY || !process.env.STARSHIPIT_SUBSCRIPTION_KEY) {
    return next(new AppError('Starshipit API keys are not configured', 500));
  }

  // Calculate weight
  let totalWeightGrams = 0;
  if (order.lineItems && order.lineItems.length > 0) {
    for (const item of order.lineItems) {
      if (item.sku) {
        // Find variant by SKU across all products
        const product = await Product.findOne({ 'variants.sku': item.sku });
        if (product) {
          const variant = product.variants.find(v => v.sku === item.sku);
          if (variant && variant.weightGrams) {
            totalWeightGrams += (variant.weightGrams * item.quantity);
          }
        }
      }
    }
  }

  // Fallback to 500g if no weight could be calculated
  if (totalWeightGrams === 0) totalWeightGrams = 500;

  // Convert to Kilograms for Starshipit
  const weightKg = totalWeightGrams / 1000;

  try {
    // 1. Create Shipment via Service
    const shippingResult = await starshipitService.createShipment({
      order,
      origin: settings.shippingOrigin,
      weightKg
    });

    let { trackingNumber, trackingCarrier, labelUrl, warning } = shippingResult as any;
    let shipmentStatus = trackingNumber ? 'Label Generated' : (warning ? 'Order Created in Starshipit (Label Pending)' : 'Order Created in Starshipit');
    let trackingUrl = '';

    if (!trackingNumber || !labelUrl) {
      try {
        let details = await starshipitService.getShipmentDetails(shippingResult.orderId);
        // Retry once if we still lack both
        if (!details.trackingNumber && !details.labelUrl) {
          details = await starshipitService.getShipmentDetails(shippingResult.orderId);
        }
        trackingNumber = trackingNumber || details.trackingNumber;
        trackingCarrier = trackingCarrier || details.trackingCarrier;
        labelUrl = labelUrl || details.labelUrl;
        trackingUrl = trackingUrl || details.trackingUrl || '';
        if (details.shipmentStatus) shipmentStatus = details.shipmentStatus;
      } catch (detailsError: any) {
        console.warn('Failed to fetch shipment details, saving orderId only:', detailsError.message);
      }
    }

    if (!trackingUrl && trackingCarrier && trackingNumber) {
      const carrierLower = trackingCarrier.toLowerCase();
      if (carrierLower.includes('australia post') || carrierLower.includes('auspost') || carrierLower.includes('mypost')) {
        trackingUrl = `https://auspost.com.au/mypost/track/#/details/${trackingNumber}`;
      } else {
        trackingUrl = `https://www.google.com/search?q=${trackingNumber}`;
      }
    }

    // 2. Update Order
    order.starshipitOrderId = shippingResult.orderId;
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (trackingCarrier) order.trackingCarrier = trackingCarrier;
    if (labelUrl) order.labelUrl = labelUrl;
    if (trackingUrl) order.trackingUrl = trackingUrl;
    order.shipmentStatus = shipmentStatus;

    if (trackingNumber) {
      order.status = 'shipped';
      order.shippedAt = new Date();
    } else {
      order.status = 'processing';
    }

    await order.save();

    if (order.trackingNumber) {
      sendShipmentConfirmationEmail(order).catch(err => console.error('Failed to send shipment email:', err));
    }

    res.status(200).json({
      success: true,
      message: warning ? `Order imported to Starshipit (ID: ${shippingResult.orderId}). Note: ${warning}` : 'Shipment created successfully',
      data: { order },
    });
  } catch (error: any) {
    console.error(`Starshipit Error for order ${order.orderNumber ?? order._id}: ${error?.message}`);
    return next(new AppError(error.message || 'Failed to create shipment with Starshipit', 500));
  }
});

/**
 * POST /api/admin/orders/:id/refund
 *
 * Process a refund for an order. If paid via Tagada, it calls the Tagada API.
 */
export const refundOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id).lean();

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  // 1. Explicit business switch (H-6). Default: enabled in sandbox, disabled in production.
  if (!refundsEnabled(process.env, config.tagadaEnv)) {
    return next(new AppError(
      'Refunds from the admin panel are disabled (REFUNDS_ENABLED is not "true"). ' +
      'Ask the business owner to enable them, or issue the refund in the Tagada dashboard — it will sync here via webhook.',
      403
    ));
  }
  if (order.paymentMethod === 'tagada' && order.tagadaEnv && order.tagadaEnv !== config.tagadaEnv) {
    return next(new AppError(`This order was paid in the Tagada ${order.tagadaEnv} environment but the server is configured for ${config.tagadaEnv}.`, 409));
  }

  if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'partially_refunded') {
    return next(new AppError('Only paid or partially refunded orders can be refunded', 400));
  }

  // 2. Validate amount (finite, > 0, <= remaining, <= 2 dp; full refund only with full:true)
  const { amount, full, reason = 'Admin initiated refund' } = req.body ?? {};
  const v = validateRefundRequest({ amount, full, grandTotal: order.grandTotal ?? order.totalAmount, refundedAmount: order.refundedAmount });
  if (!v.ok) {
    return next(new AppError(v.error, v.status));
  }

  const isTagada = order.paymentMethod === 'tagada';
  const tagadaPaymentRef = [order.tagadaProviderPaymentId, order.tagadaPaymentId].find(isUsableExternalId);
  if (isTagada && !tagadaPaymentRef) {
    return next(new AppError('No Tagada payment ID found for this order', 400));
  }

  // 3. Atomic reservation — concurrent refunds cannot exceed the order total.
  const reserved = await reserveRefund(order._id, v.amount, { pending: true });
  if (!reserved) {
    return next(new AppError('Refund exceeds the remaining refundable amount (another refund may be in progress).', 409));
  }

  const adminUser = (req as any).admin || (req as any).user;
  const refund: any = await Refund.create({
    order: order._id,
    amount: v.amount,
    reason: String(reason).slice(0, 500),
    type: v.type,
    status: 'pending',
    source: 'admin',
    initiatedBy: adminUser?.email,
  });

  // 4. Provider call (amount in minor units). Roll back the reservation on failure.
  if (isTagada) {
    try {
      const client = await getTagadaClient();
      if (typeof client?.payments?.refund !== 'function') throw new Error('Tagada SDK does not support refunds in this version.');
      // idempotencyKey: the SDK retries POSTs internally, so the key guarantees one refund per Refund doc.
      const providerRes = await withTimeout(
        client.payments.refund(
          {
            paymentIds: [tagadaPaymentRef as string],
            amount: toMinorUnits(v.amount),
            metadata: { reason: String(reason).slice(0, 200), orderId: String(order._id), refundId: String(refund._id) },
          },
          { idempotencyKey: `refund-${refund._id}`, timeout: TAGADA_TIMEOUT_MS }
        ),
        TAGADA_TIMEOUT_MS * 3 + 5000,
        'tagada.payments.refund'
      );
      const tagadaRefundId = extractRefundId(providerRes);
      if (tagadaRefundId) {
        refund.tagadaRefundId = tagadaRefundId;
        await refund.save();
      }
      // Stays 'pending' until the refund webhook confirms it.
    } catch (error: any) {
      const isTimeout = error?.name === 'TimeoutError' || /timed out|timeout|abort/i.test(String(error?.name) + String(error?.message));
      if (isTimeout) {
        // Outcome unknown: the provider may still have processed it. Keep the reservation and the
        // pending Refund; the refund webhook (or a manual check) reconciles it. Never roll back here.
        refund.failureReason = 'Provider timeout — outcome unknown, awaiting webhook confirmation';
        await refund.save();
        console.error(`[Refund] order=${order._id} provider refund timed out — left pending`);
        return res.status(202).json({
          success: true,
          message: 'Refund request timed out at TagadaPay; it is pending confirmation. Check the Tagada dashboard before retrying.',
          data: { refund },
        });
      }
      await releaseRefund(order._id, v.amount, { pending: true });
      refund.status = 'failed';
      refund.failureReason = String(error?.response?.data?.message || error?.message || 'Provider error').slice(0, 500);
      await refund.save();
      console.error(`[Refund] order=${order._id} provider refund failed: ${refund.failureReason}`);
      const status = error?.name === 'TimeoutError' ? 504 : 502;
      return next(new AppError(`Refund failed at TagadaPay: ${refund.failureReason}`, status));
    }
  } else {
    // Offline/manual payment: nothing to call — the refund is recorded as done.
    refund.status = 'succeeded';
    await refund.save();
    await confirmReservedRefund(order._id, v.amount);
  }

  // 5. Payment status via the transition guard.
  const latest: any = await Order.findById(order._id).lean();
  await transitionPaymentStatus(order._id, refundTargetStatus(latest));
  const updated = await Order.findById(order._id).lean();

  res.status(200).json({
    success: true,
    message: isTagada ? 'Refund submitted to TagadaPay (pending confirmation)' : 'Refund recorded',
    data: { order: updated, refund },
  });
});

/**
 * GET /api/admin/orders/:id/refunds
 *
 * Fetch all refunds for a specific order.
 */
export const getOrderRefunds = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const refunds = await Refund.find({ order: req.params.id }).sort('-createdAt');

  res.status(200).json({
    success: true,
    data: { refunds },
  });
});

/**
 * POST /api/admin/orders
 *
 * Creates a new manual order from the admin panel.
 * - Resolves or creates a Customer profile
 * - Decrements stock for products/variants
 * - Calculates subtotal, discounts, shipping, and grand total
 * - Generates SLT#######B order number
 * - Saves order with source = 'admin_manual'
 */
export const createAdminOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {

  const {
    customerId,
    customer,
    shippingAddressObj,
    billingAddressObj,
    lineItems,
    shippingMethod,
    shippingCost = 0,
    discountTotal = 0,
    notes = '',
    paymentStatus = 'pending',
    sendEmail = false,
  } = req.body;

  // 1. Basic validation
  if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
    return next(new AppError('At least one line item is required to create an order.', 400));
  }
  if (lineItems.length > 50) {
    return next(new AppError('At most 50 line items per order.', 400));
  }
  if (!['pending', 'paid'].includes(paymentStatus)) {
    return next(new AppError("paymentStatus must be 'pending' or 'paid'.", 400));
  }

  const email = typeof customer?.email === 'string' ? customer.email.trim().toLowerCase() : '';
  if (!email) {
    return next(new AppError('Customer email is required.', 400));
  }

  // 2. Resolve or create Customer record (lifetime stats are updated by onOrderPaid)
  let customerDoc: any = null;
  if (customerId) {
    customerDoc = await Customer.findById(customerId);
  }
  if (!customerDoc) {
    customerDoc = await Customer.findOne({ email });
  }

  const customerName = `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || 'Guest Customer';

  if (!customerDoc) {
    customerDoc = await Customer.create({
      name: customerName,
      email,
      phone: customer?.phone || '',
      defaultAddress: shippingAddressObj || billingAddressObj || {},
      country: shippingAddressObj?.country || 'AU',
      orderCount: 0,
      totalSpent: 0,
    });
  }

  // 3. Resolve line items (variant by _id / tagadaVariantId / sku; quantity 1..100)
  const processedLineItems: any[] = [];
  const stockLines: Array<{ product: unknown; variant: unknown | null; quantity: number; sku?: string; price: number }> = [];
  let calculatedSubtotal = 0;

  for (const item of lineItems) {
    if (!item.productId && !item.title) {
      return next(new AppError('Line item must include a valid product or title.', 400));
    }

    let qty: number;
    try {
      qty = parseQuantity(item.quantity ?? 1);
    } catch (e) {
      if (e instanceof CheckoutValidationError) return next(new AppError(`Quantity must be an integer between 1 and ${MAX_LINE_QUANTITY}.`, 400));
      throw e;
    }

    let productDoc: any = null;
    if (item.productId) {
      productDoc = await Product.findById(item.productId).lean();
      if (!productDoc) return next(new AppError(`Product ${item.productId} not found.`, 404));
    }

    const parsedPrice = typeof item.unitPrice === 'number' ? item.unitPrice : parseFloat(item.unitPrice || '0');
    let unitPrice = Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : 0;
    let title = item.title || productDoc?.name || 'Item';
    let variantTitle = item.variantTitle || '';
    let sku = item.sku || productDoc?.sku || '';
    const productImageUrl = item.productImageUrl || productDoc?.images?.[0] || productDoc?.image || productDoc?.imageUrl || '';

    if (productDoc) {
      title = productDoc.name;
      let variant: any = null;
      if (Array.isArray(productDoc.variants) && productDoc.variants.length > 0) {
        const key = item.variantId != null ? String(item.variantId) : '';
        variant = key
          ? productDoc.variants.find((v: any) => String(v._id) === key || v.tagadaVariantId === key || (v.sku && v.sku === key))
          : (productDoc.variants.length === 1 ? productDoc.variants[0] : null);
        if (!variant) {
          return next(new AppError(`Please select a valid variant for '${productDoc.name}'.`, 400));
        }
        variantTitle = variant.title || variant.name || variantTitle;
        sku = variant.sku || sku;
        if (unitPrice === 0 && variant.price) unitPrice = Number(variant.price) || 0;
      }
      if (unitPrice === 0 && productDoc.price) unitPrice = Number(productDoc.price) || 0;
      stockLines.push({ product: productDoc._id, variant: variant?._id ?? null, quantity: qty, sku, price: unitPrice });
    }

    const lineDiscount = Math.max(0, parseFloat(item.discountAmount || 0) || 0);
    const lineSubtotal = Math.max(0, (unitPrice * qty) - lineDiscount);
    calculatedSubtotal += lineSubtotal;

    processedLineItems.push({ title, variantTitle, sku, quantity: qty, unitPrice, subtotal: lineSubtotal, productImageUrl });
  }

  // 4. Financial calculations
  const parsedShippingCost = Math.max(0, parseFloat(shippingCost) || 0);
  const parsedDiscountTotal = Math.max(0, parseFloat(discountTotal) || 0);
  const grandTotal = Math.max(0, calculatedSubtotal - parsedDiscountTotal + parsedShippingCost);

  // 5. Admin user credentials (audit log)
  const adminUser = (req as any).admin;
  const createdByAdmin = adminUser ? {
    id: adminUser._id?.toString() || adminUser.id,
    email: adminUser.email,
    name: adminUser.name || adminUser.email
  } : undefined;

  // 6. Create Order document (order number retried on E11000)
  const isPaid = paymentStatus === 'paid';
  const now = new Date();
  const order: any = await withOrderNumberRetry((orderNumber) => Order.create({
    orderNumber,
    customer: {
      firstName: customer?.firstName || customerDoc.name?.split(' ')[0] || '',
      lastName: customer?.lastName || customerDoc.name?.split(' ').slice(1).join(' ') || '',
      email,
      phone: customer?.phone || customerDoc.phone || '',
    },
    customerEmail: email,
    customerName,
    shippingAddressObj: shippingAddressObj || billingAddressObj || {},
    billingAddressObj: billingAddressObj || shippingAddressObj || {},
    shippingAddress: shippingAddressObj ? `${shippingAddressObj.street1 || ''}, ${shippingAddressObj.city || ''} ${shippingAddressObj.state || ''} ${shippingAddressObj.zip || ''} ${shippingAddressObj.country || ''}` : '',
    lineItems: processedLineItems,
    products: stockLines.map((l) => ({
      product: l.product, variant: l.variant, quantity: l.quantity, price: l.price, sku: l.sku,
    })),
    subtotal: calculatedSubtotal,
    discountAmount: parsedDiscountTotal,
    shippingAmount: parsedShippingCost,
    grandTotal,
    totalAmount: grandTotal,
    currency: 'AUD',
    shippingMethodName: shippingMethod || 'Australia Post Express Shipping',
    status: isPaid ? 'processing' : 'pending',
    fulfilmentStatus: 'unfulfilled',
    paymentMethod: 'manual_offline',
    paymentStatus: isPaid ? 'paid' : 'pending',
    paidAt: isPaid ? now : null,
    publicAccessToken: generateOrderAccessToken(),
    // Manual orders: customer confirmation email only when the admin asked for it.
    suppressConfirmationEmail: isPaid ? !sendEmail : true,
    // Stock is reserved below at creation, so onOrderPaid must not decrement again.
    inventoryDecrementedAt: now,
    source: 'admin_manual',
    createdByAdmin,
    adminNotes: String(notes).slice(0, 5000),
    comments: [{
      text: `Order created manually by admin (${adminUser?.email || 'admin'}). Payment status: ${isPaid ? 'Paid (manual)' : 'Pending'}.`,
      createdAt: now,
    }],
  }));

  // 7. Atomic stock decrement (manual orders reserve stock at creation, paid or not)
  for (const line of stockLines) {
    try {
      await decrementLineForOrder(order._id, line);
    } catch (err: any) {
      console.error(`[Admin Order] Stock decrement failed for order ${order._id}: ${err?.message}`);
    }
  }

  // 8. Trigger Google Address Validation asynchronously
  if (order.shippingAddressObj) {
    AddressValidationService.validateOrderAddress(order._id).catch((err: any) => {
      console.error('[Admin Order] Address Validation Error:', err?.message);
    });
  }

  // 9. Pending manual order with "send email": legacy behaviour — send now.
  if (sendEmail && !isPaid) {
    try {
      await sendOrderConfirmationEmail(order);
    } catch (err: any) {
      console.error('[Admin Order] Failed to send order confirmation email:', err?.message);
    }
  }

  // Admin notification at creation (onOrderPaid skips it for admin_manual orders)
  try {
    await sendAdminNewOrderNotificationEmail(order);
  } catch (err: any) {
    console.error('[Admin Order] Failed to send admin order notification email:', err?.message);
  }

  // 10. Paid manual order → idempotent post-payment side effects (customer stats, email, analytics…)
  if (isPaid) scheduleOnOrderPaid(order._id);

  const fresh = await Order.findById(order._id).lean();
  res.status(201).json({
    success: true,
    message: 'Manual order created successfully',
    data: { order: fresh ?? order },
  });
});

/**
 * GET /api/admin/orders/new-config
 *
 * Config presets for building the manual order creation form.
 */
export const getNewOrderConfig = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      shippingMethods: [
        { code: 'AUS_POST_EXPRESS', name: 'Australia Post Express Shipping', defaultCost: 15.00 },
        { code: 'AUS_POST_STANDARD', name: 'Australia Post Standard Shipping', defaultCost: 10.00 },
        { code: 'CUSTOM_SHIPPING', name: 'Custom / Direct Shipping', defaultCost: 0.00 },
      ],
      paymentStatuses: [
        { code: 'pending', label: 'Pending Payment' },
        { code: 'paid', label: 'Paid (Manual / Offline)' },
      ],
      currency: 'AUD',
    },
  });
});

/**
 * POST /api/admin/orders/:id/revalidate-address
 *
 * Clears cached address validation and re-runs it from scratch.
 */
export const revalidateOrderAddress = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  // Clear old cached result so the service will re-run
  order.addressValidation = undefined as any;
  await order.save({ validateBeforeSave: false });

  // Trigger fresh validation asynchronously
  AddressValidationService.validateOrderAddress(order._id).catch(err => {
    console.error('[Admin Order] Re-validation Error:', err);
  });

  res.status(200).json({
    success: true,
    message: 'Address re-validation triggered. Refresh the order shortly to see updated results.',
  });
});

/**
 * GET /api/admin/orders/address/autocomplete
 * Provides Google Places Autocomplete API proxy for address search
 */
export const addressAutocomplete = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const query = req.query.q as string;
  if (!query) {
    return res.status(200).json({ success: true, predictions: [] });
  }

  const apiKey = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;
  if (!apiKey) {
    return next(new AppError('Google API key not configured', 500));
  }

  try {
    const response = await axios.get(`https://maps.googleapis.com/maps/api/place/autocomplete/json`, {
      params: {
        input: query,
        key: apiKey,
        types: 'geocode'
      }
    });

    res.status(200).json({
      success: true,
      predictions: response.data.predictions || []
    });
  } catch (err: any) {
    console.error('[Address Autocomplete] Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, predictions: [] });
  }
});

/**
 * GET /api/admin/orders/address/place-details
 * Provides Google Geocode API proxy to fetch full address components from a place_id
 */
export const addressPlaceDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const placeId = req.query.place_id as string;
  if (!placeId) {
    return res.status(400).json({ success: false, message: 'place_id is required' });
  }

  const apiKey = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;
  if (!apiKey) {
    return next(new AppError('Google API key not configured', 500));
  }

  try {
    const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json`, {
      params: {
        place_id: placeId,
        key: apiKey
      }
    });

    const result = response.data.results?.[0];
    if (!result) {
      return res.status(404).json({ success: false, message: 'Address details not found' });
    }

    res.status(200).json({
      success: true,
      address: result
    });
  } catch (err: any) {
    console.error('[Address Place Details] Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch address details' });
  }
});

/**
 * GET /api/admin/orders/export/csv
 * Export orders to CSV including attribution fields
 */
export const exportOrdersCsv = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const orders = await Order.find().sort({ createdAt: -1 }).lean();

  const headers = [
    'Order Number',
    'Date',
    'Customer Name',
    'Customer Email',
    'Payment Status',
    'Fulfilment Status',
    'Total Amount',
    'First Touch Source',
    'First Touch Channel',
    'Source Domain',
    'UTM Source',
    'UTM Medium',
    'UTM Campaign',
    'Landing Page',
    'Referrer URL'
  ];

  const rows = orders.map((o: any) => {
    const custName = [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || o.customerName || '';
    const custEmail = o.customer?.email || o.customerEmail || '';
    const total = o.grandTotal ?? o.totalAmount ?? 0;

    return [
      o.orderNumber || String(o._id).slice(-6),
      new Date(o.createdAt).toISOString(),
      `"${custName.replace(/"/g, '""')}"`,
      `"${custEmail.replace(/"/g, '""')}"`,
      o.paymentStatus || '',
      o.fulfilmentStatus || '',
      total,
      `"${(o.attribution?.firstTouch?.source || 'Direct / Unknown').replace(/"/g, '""')}"`,
      `"${(o.attribution?.firstTouch?.channel || 'direct').replace(/"/g, '""')}"`,
      `"${(o.attribution?.firstTouch?.sourceDomain || '').replace(/"/g, '""')}"`,
      `"${(o.attribution?.firstTouch?.utmSource || '').replace(/"/g, '""')}"`,
      `"${(o.attribution?.firstTouch?.utmMedium || '').replace(/"/g, '""')}"`,
      `"${(o.attribution?.firstTouch?.utmCampaign || '').replace(/"/g, '""')}"`,
      `"${(o.attribution?.firstTouch?.landingPage || '').replace(/"/g, '""')}"`,
      `"${(o.attribution?.firstTouch?.referrerUrl || '').replace(/"/g, '""')}"`
    ];
  });

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=orders_export.csv');
  res.status(200).send(csvContent);
});

/**
 * DELETE /api/admin/orders/:id/soft-delete
 * Soft delete an order so it moves to the "Deleted Orders" tab.
 */
export const softDeleteOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  order.isDeleted = true;
  await order.save({ validateBeforeSave: false });

  res.status(200).json({
    success: true,
    message: 'Order moved to deleted orders list',
    order
  });
});

/**
 * PATCH /api/admin/orders/:id/restore
 * Restore a soft deleted order so it returns to the main listings.
 */
export const restoreOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  order.isDeleted = false;
  await order.save({ validateBeforeSave: false });

  res.status(200).json({
    success: true,
    message: 'Order restored successfully',
    order
  });
});

/**
 * POST /api/admin/orders/bulk-soft-delete
 * Bulk soft delete orders.
 */
export const bulkSoftDeleteOrders = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return next(new AppError('Please provide an array of order IDs', 400));
  }

  await Order.updateMany(
    { _id: { $in: ids } },
    { $set: { isDeleted: true } }
  );

  res.status(200).json({
    success: true,
    message: `${ids.length} orders moved to deleted list`
  });
});

/**
 * POST /api/admin/orders/bulk-restore
 * Bulk restore soft deleted orders.
 */
export const bulkRestoreOrders = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return next(new AppError('Please provide an array of order IDs', 400));
  }

  await Order.updateMany(
    { _id: { $in: ids } },
    { $set: { isDeleted: false } }
  );

  res.status(200).json({
    success: true,
    message: `${ids.length} orders restored successfully`
  });
});

