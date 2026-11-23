import { Request, Response, NextFunction } from 'express';
import Order from '../../models/order.model';
import Product from '../../models/product.model';
import StoreSettings from '../../models/StoreSettings';
import { starshipitService, labelWarning } from '../../services/shipping/starshipit.service';
import { sendOrderConfirmationEmail, sendAdminNewOrderNotificationEmail, sendShipmentConfirmationEmail } from '../../services/emailService';
import { buildTrackingUrl, sendShipmentEmailOnce } from '../../services/shipping/shipmentNotify';
import { syncCarrierScans } from '../../services/shipping/starshipitTracking';
import { recordLabelDuplicate } from '../../services/shipping/labelDuplicates';
import { computeShipmentWeight, chooseShipmentPackage } from '../../services/shipping/shipmentWeight';
import { applyTrackingStage, deliverySummary, deliveryFilterQuery, stageFromStatus, MANUAL_STAGES, STAGE_LABELS, DELIVERY_FILTERS, type DeliveryStage, type DeliveryFilter } from '../../services/shipping/deliveryStatus';
import AppError from '../../utils/appError';
import catchAsync from '../../utils/catchAsync';
import Refund from '../../models/Refund';
import Customer from '../../models/Customer';
import AddressValidationService from '../../services/addressValidation.service';
import axios from 'axios';
import { PAYMENT_STATUSES, PaymentStatus } from '../../domain/orderTransitions';
import { validateRefundRequest } from '../../domain/money';
import { generateOrderAccessToken } from '../../domain/orderAccess';
import { transitionPaymentStatus } from '../../services/orders/paymentTransition';
import { scheduleOnOrderPaid } from '../../services/orders/onOrderPaid';
import { sendConfirmationWithTimeline, customerEmailOf, adminLabelOf } from '../../services/orders/confirmationEmail';
import { isBankMethod } from '../../services/checkout/bankTransfer';
import { withOrderNumberRetry } from '../../services/orders/orderNumber';
import { reserveRefund, confirmReservedRefund, refundTargetStatus } from '../../services/orders/refunds';
import { decrementLineForOrder, LowStockCrossing, releaseReservedStock } from '../../services/orders/inventory';
import { releaseDiscountUse } from '../../services/discounts/discountService';
import { sendOrderLowStockAlert } from '../../services/lowStockAlert';
import { parseQuantity, CheckoutValidationError, MAX_LINE_QUANTITY } from '../../services/orders/checkoutItems';

/**
 * GET /api/admin/orders
 *
 * Paginated, filterable list of all orders.
 * Query params:
 *   status            - pending | processing | shipped | delivered | cancelled
 *   paymentStatus     - pending | paid | failed | refunded
 *   fulfilmentStatus  - unfulfilled | fulfilled | partial
 *   q                 - search by orderNumber or customer.email
 *   delivery          - not_shipped | label_pending | label_created | in_transit | out_for_delivery | delayed | issue | delivered
 *   destination       - au | international (shipping country)
 *   paymentMethod     - payid | bank_transfer | international_bank_transfer | tagada (legacy card orders) | manual_offline
 *   from, to          - order date range (ISO times; to is exclusive)
 *   page              - 1-indexed page number (default: 1)
 *   limit             - results per page (default: 50)
 */
export const getOrders = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const {
    status,
    paymentStatus,
    fulfilmentStatus,
    q,
    sortBy,
    sortOrder,
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

  // Filters (Admin → Orders filter bar). Only known values are used, so a query string can never
  // inject a MongoDB operator. Each filter adds an AND condition.
  const pick = (v: unknown, allowed: readonly string[]) => (typeof v === 'string' && allowed.includes(v) ? v : undefined);
  const extra: Record<string, any>[] = [];
  const BANK = ['payid', 'bank_transfer', 'international_bank_transfer'];

  const statusQ = pick(status, ['pending', 'processing', 'shipped', 'delivered', 'cancelled']);
  if (statusQ) filter.status = statusQ;

  // Payment: "awaiting_payment" = bank transfer / PayID orders waiting for the admin to confirm
  const paymentQ = req.query.awaitingPayment === 'true' ? 'awaiting_payment'
    : pick(paymentStatus, ['pending', 'awaiting_payment', 'paid', 'partially_refunded', 'refunded', 'cancelled', 'failed']);
  if (paymentQ === 'awaiting_payment') {
    filter.paymentStatus = 'pending';
    filter.paymentMethod = { $in: BANK };
  } else if (paymentQ) {
    filter.paymentStatus = paymentQ;
  }

  const methodQ = pick(req.query.paymentMethod, ['payid', 'bank_transfer', 'international_bank_transfer', 'tagada', 'manual_offline']);
  if (methodQ === 'tagada') {
    // Legacy card orders from the retired TagadaPay checkout; the oldest have no payment method saved
    extra.push({ $or: [{ paymentMethod: 'tagada' }, { paymentMethod: { $in: [null, ''] }, source: { $nin: ['admin_manual', 'shopify_import'] } }] });
  } else if (methodQ && paymentQ !== 'awaiting_payment') filter.paymentMethod = methodQ;
  else if (methodQ) extra.push({ paymentMethod: methodQ });

  const fulfilQ = pick(fulfilmentStatus, ['unfulfilled', 'fulfilled', 'partial']);
  if (fulfilQ === 'unfulfilled') extra.push({ fulfilmentStatus: { $in: ['unfulfilled', null] } });
  else if (fulfilQ) filter.fulfilmentStatus = fulfilQ;

  // Delivery: the same rules as the Delivery Status column (services/shipping/deliveryStatus.ts)
  const deliveryQ = pick(req.query.delivery, DELIVERY_FILTERS);
  if (deliveryQ) extra.push(deliveryFilterQuery(deliveryQ as DeliveryFilter));

  // Destination: shipping country Australia vs anywhere else
  const AU_RX = /^\s*(au|aus|australia)\s*$/i;
  if (req.query.destination === 'au') extra.push({ 'shippingAddressObj.country': { $regex: AU_RX } });
  else if (req.query.destination === 'international') {
    extra.push({ 'shippingAddressObj.country': { $nin: [null, ''] } }, { 'shippingAddressObj.country': { $not: AU_RX } });
  }

  // Date range on the order date (the admin sends exact ISO times for Sydney day boundaries)
  const asDate = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 40) return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  };
  const from = asDate(req.query.from);
  const to = asDate(req.query.to);
  if (from || to) extra.push({ createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } });

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

  if (extra.length) filter.$and = [...(filter.$and || []), ...extra];

  let sort: Record<string, 1 | -1> = { createdAt: -1, _id: -1 };
  if (sortBy === 'orderNumber') {
    sort = { orderNumber: sortOrder === 'asc' ? 1 : -1, _id: -1 };
  } else if (sortBy === 'createdAt' || sortBy === 'date') {
    sort = { createdAt: sortOrder === 'asc' ? 1 : -1, _id: -1 };
  }

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Order.countDocuments(filter),
  ]);

  const now = new Date();
  res.status(200).json({
    success: true,
    results: orders.length,
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum),
    data: {
      // delivery: the status shown in the Delivery Status column (same logic as the order page)
      orders: orders.map((o: any) => ({ ...o, delivery: deliverySummary(o, now) })),
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

  // The CRM customer record for this order (customers are keyed by lower-cased email; orders only
  // carry the email), so the admin can open the customer's profile / order history.
  const email = String(order?.customer?.email || order?.customerEmail || '').trim().toLowerCase();
  const customerRecord = email ? await Customer.findOne({ email }).select('_id').lean() : null;

  const orderObj = order?.toObject ? order.toObject() : order;

  // Fallback: if historical or imported line items lack a saved productImageUrl, resolve it from the product catalog
  if (Array.isArray(orderObj?.lineItems) && orderObj.lineItems.some((li: any) => !li.productImageUrl)) {
    const skus = orderObj.lineItems.filter((li: any) => !li.productImageUrl && li.sku).map((li: any) => li.sku);
    const titles = orderObj.lineItems.filter((li: any) => !li.productImageUrl && li.title).map((li: any) => li.title);

    try {
      const prods = await Product.find({
        $or: [
          { sku: { $in: skus } },
          { 'variants.sku': { $in: skus } },
          { name: { $in: titles } },
        ],
      }).select('sku name variants imageUrl images').lean();

      for (const li of orderObj.lineItems) {
        if (!li.productImageUrl) {
          const sku = li.sku?.toLowerCase();
          const title = li.title?.toLowerCase();
          const match = prods.find((p: any) =>
            (sku && p.sku?.toLowerCase() === sku) ||
            (sku && p.variants?.some((v: any) => v.sku?.toLowerCase() === sku)) ||
            (title && p.name?.toLowerCase() === title)
          );
          if (match) {
            li.productImageUrl = match.imageUrl || match.images?.[0]?.url || match.images?.[0]?.secureUrl || '';
          }
        }
      }
    } catch (err) {
      console.error('[getOrderById] Failed to fallback-resolve line item images:', err);
    }
  }

  res.status(200).json({
    success: true,
    data: {
      order: orderObj,
      customerId: customerRecord?._id ?? null,
    },
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

  const existing = await Order.findById(req.params.id)
    .select('_id paymentStatus paymentMethod source grandTotal confirmationEmailOptOut confirmationEmailSentAt').lean();
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
    if (t.result === 'applied') {
      const by = adminLabelOf((req as any).user);
      const text = becamePaid
        ? `Payment of $${(Number(existing.grandTotal) || 0).toFixed(2)} marked as paid by ${by}.`
        : `Payment status changed from ${existing.paymentStatus} to ${paymentStatus} by ${by}.`;
      await Order.updateOne({ _id: existing._id }, { $push: { comments: { text, createdAt: new Date() } } });
    }
    // Marked paid in the Hub (bank transfer / PayID, or an unpaid manual order): the customer gets
    // the order confirmation email now — these orders were saved with the email switched off.
    // Not when the admin unticked "Send order confirmation email", or it was already sent.
    if (becamePaid && (isBankMethod(existing.paymentMethod) || existing.source === 'admin_manual')
      && !existing.confirmationEmailOptOut && !existing.confirmationEmailSentAt) {
      await Order.updateOne({ _id: existing._id }, { $set: { suppressConfirmationEmail: false } });
    }
    // Cancelled → give back stock reserved at placement (bank transfer / PayID checkout; no-op otherwise)
    if (paymentStatus === 'cancelled' && t.result === 'applied') {
      await releaseReservedStock(existing._id).catch((err: any) =>
        console.error(`[Admin Order] Could not release reserved stock for ${existing._id}: ${err?.message}`));
      await releaseDiscountUse(existing._id).catch((err: any) =>
        console.error(`[Admin Order] Could not release discount use for ${existing._id}: ${err?.message}`));
    }
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
 * POST /api/admin/order/:id/send-confirmation
 *
 * Sends (again) the customer's order confirmation email for a paid order and adds it to the timeline.
 */
export const sendOrderConfirmation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id).select('+publicAccessToken');
  if (!order || order.isDeleted) return next(new AppError('No order found with that ID', 404));
  if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) {
    return next(new AppError('The order confirmation can only be sent once the order is paid.', 400));
  }
  if (!customerEmailOf(order)) return next(new AppError('This order has no customer email address.', 400));
  try {
    await sendConfirmationWithTimeline(order, sendOrderConfirmationEmail, adminLabelOf((req as any).user));
  } catch (err: any) {
    console.error(`[Admin Order] confirmation email failed for ${order._id}: ${err?.message}`);
    return next(new AppError('The email could not be sent. Please try again in a few minutes.', 502));
  }
  const updated = await Order.findById(order._id).lean();
  res.status(200).json({ success: true, message: `Order confirmation sent to ${customerEmailOf(order)}`, data: { order: updated } });
});

/**
 * POST /api/admin/order/:id/resend-payment-details
 *
 * Emails the customer their payment instructions again (unpaid bank transfer / PayID orders)
 * and adds it to the timeline.
 */
export const resendPaymentDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id).select('+publicAccessToken');
  if (!order || order.isDeleted) return next(new AppError('No order found with that ID', 404));
  if (!isBankMethod(order.paymentMethod) || order.paymentStatus !== 'pending') {
    return next(new AppError('Payment details can only be resent for unpaid bank transfer / PayID orders.', 400));
  }
  const email = customerEmailOf(order);
  if (!email) return next(new AppError('This order has no customer email address.', 400));
  if (!order.publicAccessToken) return next(new AppError('This order has no payment page link.', 400));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getBankTransferSettings } = require('../../services/checkout/bankTransfer');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sendAwaitingPaymentEmail } = require('../../services/checkout/bankTransferEmails');
  try {
    await sendAwaitingPaymentEmail(order, await getBankTransferSettings(), order.publicAccessToken);
  } catch (err: any) {
    console.error(`[Admin Order] resend payment details failed for ${order._id}: ${err?.message}`);
    return next(new AppError('The email could not be sent. Please try again in a few minutes.', 502));
  }
  const updated = await Order.findByIdAndUpdate(
    order._id,
    { $push: { comments: { text: `Payment details re-sent to ${email} by ${adminLabelOf((req as any).user)}.`, createdAt: new Date() } } },
    { new: true }
  ).lean();
  res.status(200).json({ success: true, message: `Payment details sent to ${email}`, data: { order: updated } });
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
/**
 * Shipping labels (Starshipit). Buying a label costs money on the carrier account every time
 * (POST /orders/shipment is not idempotent), so:
 *  - createShipment is the ONLY place a label is bought, through starshipitService (which reads the
 *    Starshipit order first and never buys when it already has a label, and never retries a purchase)
 *  - an order that already has tracking is never sent for another label
 *  - one purchase per order at a time (shipmentLockUntil, atomic — double clicks, two admins, bulk + single)
 *  - after a purchase Starshipit didn't confirm, no new purchase for LABEL_UNCONFIRMED_HOLD_MS
 *  - after a confirmed purchase whose tracking hasn't synced yet (labelPurchasedAt), no new purchase at all
 *  - refreshShipment ("Check Starshipit now") only reads; it can never buy a label
 */
const LABEL_UNCONFIRMED_HOLD_MS = 15 * 60 * 1000;
// Longer than the slowest possible Starshipit run (reads with retries + 30 s purchase); released as soon as the request ends
const SHIPMENT_LOCK_MS = 5 * 60 * 1000;
const LABEL_PENDING_STATUS = 'Order Created in Starshipit (Label Pending)';

type StarshipitShipDetails = { trackingNumber?: string; trackingCarrier?: string; labelUrl?: string; trackingUrl?: string; shipmentStatus?: string };

/** Saves Starshipit's tracking / label on the order and ships it when there is a tracking number (email at most once). */
async function applyStarshipitDetails(order: any, d: StarshipitShipDetails, pendingStatus: string, opts: { markProcessing?: boolean } = {}) {
  const wasShippedBefore = order.status === 'shipped';
  const trackingNumber = order.trackingNumber || d.trackingNumber || '';
  const trackingCarrier = order.trackingCarrier || d.trackingCarrier || '';
  const labelUrl = d.labelUrl || order.labelUrl || '';
  // Carrier tracking link (Starshipit's own URL preferred; no generic Google-search link)
  const trackingUrl = buildTrackingUrl(trackingCarrier, trackingNumber, order.trackingUrl || d.trackingUrl || '');

  if (trackingNumber) order.trackingNumber = trackingNumber;
  if (trackingCarrier) order.trackingCarrier = trackingCarrier;
  if (labelUrl) order.labelUrl = labelUrl;
  if (trackingUrl) order.trackingUrl = trackingUrl;
  order.shipmentStatus = d.shipmentStatus || (trackingNumber ? 'Label Generated' : pendingStatus);

  if (trackingNumber) {
    order.status = 'shipped';
    if (!wasShippedBefore || !order.shippedAt) order.shippedAt = new Date();
    order.trackingSource = 'starshipit';
    order.labelUnconfirmedAt = undefined;
    order.labelPurchasedAt = undefined;
    applyTrackingStage(order, 'label_created');
  } else {
    if (opts.markProcessing && !wasShippedBefore) order.status = 'processing';
    // Delivery stage: international orders are only created in Starshipit (the label is printed in
    // the Starshipit dashboard, then the webhook syncs it)
    applyTrackingStage(order, 'label_pending');
  }
  await order.save();

  // At most once per order (Starshipit's "Printed" webhook can race this request)
  if (order.trackingNumber && !wasShippedBefore) await sendShipmentEmailOnce(order);
}

/**
 * MyPost refused our label because one already exists (error 51015): nothing was bought by us, but a
 * label was made some other way (Starshipit automation / dashboard) — flag it so the team checks
 * for a duplicate. Warning only; never throws. The flag is copied onto `order` for the response.
 */
async function flagLabelExistsElsewhere(order: any) {
  const flagged = await recordLabelDuplicate(order._id, {
    reason: 'label_exists_elsewhere',
    starshipitOrderIds: [order.starshipitOrderId],
    trackingNumbers: [order.trackingNumber],
  });
  if (flagged) order.labelDuplicate = flagged.labelDuplicate;
}

export const createShipment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const found = await Order.findById(req.params.id);
  if (!found) {
    return next(new AppError('No order found with that ID', 404));
  }

  if (found.source === 'shopify_import' || found.tags?.includes('shopify-import')) {
    return next(new AppError('Cannot create shipping labels for historical imported Shopify orders.', 400));
  }

  // Tracking was entered manually (label made outside Starshipit): don't create a second label
  if (found.trackingSource === 'manual' && found.trackingNumber) {
    return next(new AppError('This order already has tracking entered manually. Use Edit tracking to change it.', 400));
  }

  // Cancelled / refunded / deleted orders are never shipped (a label would be wasted money)
  if (found.isDeleted || found.status === 'cancelled' || ['cancelled', 'failed', 'refunded'].includes(String(found.paymentStatus))) {
    return next(new AppError('This order is cancelled, refunded or deleted, so no shipping label can be created.', 400));
  }

  // Already has a label: never buy another one (bulk runs, repeat clicks)
  if (found.trackingNumber) {
    return res.status(200).json({
      success: true,
      message: `This order already has a label (tracking ${found.trackingNumber}). No new label was created.`,
      data: { order: found },
    });
  }

  const isManual = found.source === 'admin_manual';
  if (['payid', 'bank_transfer', 'international_bank_transfer'].includes(String(found.paymentMethod)) && !['paid', 'partially_refunded'].includes(found.paymentStatus)) {
    return next(new AppError('Cannot create shipment: mark the order as paid first', 400));
  }
  // tagadaPaymentStatus: legacy field on orders from the retired TagadaPay checkout — still honoured
  // so an unpaid legacy card order never becomes shippable.
  if (!isManual && (found.paymentStatus === 'pending' || found.tagadaPaymentStatus === 'pending')) {
    return next(new AppError('Cannot create shipment: Payment is still pending', 400));
  }

  if (!process.env.STARSHIPIT_API_KEY || !process.env.STARSHIPIT_SUBSCRIPTION_KEY) {
    return next(new AppError('Starshipit API keys are not configured', 500));
  }

  const hints = { orderNumber: found.orderNumber, since: (found as any).createdAt };

  // A label was already bought (Starshipit confirmed it) but its tracking hasn't synced: look, never buy again
  if (found.starshipitOrderId && found.labelPurchasedAt) {
    const d = await starshipitService.readDetails(found.starshipitOrderId, hints).catch(() => null);
    if (d?.trackingNumber && !d.archived) {
      await applyStarshipitDetails(found, d, LABEL_PENDING_STATUS);
      return res.status(200).json({ success: true, message: 'Label found in Starshipit — tracking added. No new label was created.', data: { order: found } });
    }
    return next(new AppError('A label was already bought for this order in Starshipit, but its tracking number has not synced yet. No new label was created. Use "Check Starshipit now" in a minute, or open the order in Starshipit (Reprint label is free; never use Redo shipping).', 409));
  }

  // A recent purchase that Starshipit never confirmed may still turn up: look (read-only), don't buy
  if (found.starshipitOrderId && found.labelUnconfirmedAt && Date.now() - new Date(found.labelUnconfirmedAt).getTime() < LABEL_UNCONFIRMED_HOLD_MS) {
    const d = await starshipitService.readDetails(found.starshipitOrderId, hints).catch(() => null);
    if (d?.trackingNumber && !d.archived) {
      await applyStarshipitDetails(found, d, LABEL_PENDING_STATUS);
      return res.status(200).json({ success: true, message: 'The earlier label request did go through in Starshipit — tracking added. No new label was created.', data: { order: found } });
    }
    const mins = Math.max(1, Math.ceil((LABEL_UNCONFIRMED_HOLD_MS - (Date.now() - new Date(found.labelUnconfirmedAt).getTime())) / 60000));
    return next(new AppError(`A label request for this order was not confirmed by Starshipit yet. To avoid a double charge, a new label can't be created for another ${mins} min. Use "Check Starshipit now", or check the order in Starshipit (Printed = done; use Reprint label, not Redo shipping).`, 409));
  }

  // Only needed when the order still has to be sent to Starshipit
  let settings: any = null;
  let weight: any = null;
  let packageChoice: any = null;
  let shipmentWarnings: string[] = [];
  if (!found.starshipitOrderId) {
    if (!found.shippingAddressObj) {
      return next(new AppError('Order missing shipping address', 400));
    }
    if (found.addressValidation?.needsReview) {
      return next(new AppError('Cannot create shipment: Shipping address needs review and must be verified first', 400));
    }
    // Get Store Settings for 'From' address
    settings = await StoreSettings.findOne();
    if (!settings || !settings.shippingOrigin) {
      return next(new AppError('Store shipping origin address not configured in settings', 400));
    }
    // Weight of the contents: per line from the variant weights (products[], or legacy lineItems on old TagadaPay orders);
    // missing/invalid weights use a fallback and are reported to the admin
    weight = await computeShipmentWeight(found);
    // One parcel: the package selected on the order's products (largest wins), else the Default
    packageChoice = await chooseShipmentPackage(weight.lines);
    shipmentWarnings = [...weight.warnings, ...packageChoice.warnings];
  }

  // One label purchase per order at a time (atomic): a second click / admin / bulk run waits
  // The same conditions as the checks above are part of the lock, so a request that finished in the
  // meantime (tracking saved, or a hold set) can never be followed by a second purchase.
  const now = new Date();
  const order: any = await Order.findOneAndUpdate(
    {
      _id: found._id,
      trackingNumber: { $in: [null, ''] },
      labelPurchasedAt: null,
      $and: [
        { $or: [{ shipmentLockUntil: null }, { shipmentLockUntil: { $lte: now } }] },
        { $or: [{ labelUnconfirmedAt: null }, { labelUnconfirmedAt: { $lte: new Date(now.getTime() - LABEL_UNCONFIRMED_HOLD_MS) } }] },
      ],
    },
    { $set: { shipmentLockUntil: new Date(now.getTime() + SHIPMENT_LOCK_MS) } },
    { new: true }
  );
  if (!order) {
    const latest: any = await Order.findById(found._id);
    if (latest?.trackingNumber) {
      return res.status(200).json({ success: true, message: `This order already has a label (tracking ${latest.trackingNumber}). No new label was created.`, data: { order: latest } });
    }
    if (latest?.labelPurchasedAt || latest?.labelUnconfirmedAt) {
      return next(new AppError('A label request for this order has just been made and is not confirmed yet. No new label was created. Use "Check Starshipit now" in a minute.', 409));
    }
    return next(new AppError('A label is already being created for this order. Please wait a moment, then refresh.', 409));
  }

  try {
    // Already in Starshipit: buy the label only if Starshipit doesn't have one yet
    if (order.starshipitOrderId) {
      const outcome = await starshipitService.purchaseLabel(order.starshipitOrderId, hints);
      const details = 'details' in outcome && outcome.details ? outcome.details : {};
      if (outcome.kind === 'unconfirmed') order.labelUnconfirmedAt = new Date();
      if (outcome.kind === 'purchased' && !(details as any).trackingNumber) order.labelPurchasedAt = new Date();
      await applyStarshipitDetails(order, details, LABEL_PENDING_STATUS);
      if (outcome.kind === 'failed' && outcome.existsElsewhere) await flagLabelExistsElsewhere(order);
      const warning = labelWarning(outcome);
      return res.status(200).json({
        success: true,
        message: outcome.kind === 'existing'
          ? 'Starshipit already had a label for this order — tracking synced. No new label was created.'
          : order.trackingNumber ? 'Shipping label created' : `Order is in Starshipit (ID: ${order.starshipitOrderId}).`,
        ...(warning ? { warning } : {}),
        data: { order },
      });
    }

    // 1. Send to Starshipit (or reuse the order an earlier attempt created), then buy the label at most once
    const shippingResult = await starshipitService.createShipment({
      order,
      origin: settings.shippingOrigin,
      weightKg: weight.itemsGrams / 1000,
      weight,
      packageChoice,
    });

    // 2. Update Order
    order.starshipitOrderId = shippingResult.orderId;
    if (shippingResult.parcel) {
      order.shipmentWeight = { ...shippingResult.parcel, warnings: shipmentWarnings, calculatedAt: new Date() };
    }
    if (shippingResult.outcome === 'unconfirmed') order.labelUnconfirmedAt = new Date();
    if (shippingResult.outcome === 'purchased' && !shippingResult.trackingNumber) order.labelPurchasedAt = new Date();
    const warning = shippingResult.warning;
    await applyStarshipitDetails(order, shippingResult, warning ? LABEL_PENDING_STATUS : 'Order Created in Starshipit', { markProcessing: true });
    if (shippingResult.existsElsewhere) await flagLabelExistsElsewhere(order);

    // Shown to the admin as a warning toast (weight fallbacks and/or a Starshipit warning)
    const warnings = [...shipmentWarnings, ...(warning ? [warning] : [])];
    return res.status(200).json({
      success: true,
      message: shippingResult.outcome === 'existing'
        ? 'Starshipit already had a label for this order — tracking synced. No new label was created.'
        : warning ? `Order imported to Starshipit (ID: ${shippingResult.orderId}). Note: ${warning}` : 'Shipment created successfully',
      ...(warnings.length ? { warning: warnings.join(' · ') } : {}),
      data: { order },
    });
  } catch (error: any) {
    console.error(`Starshipit Error for order ${order.orderNumber ?? order._id}: ${error?.message}`);
    return next(new AppError(error.message || 'Failed to create shipment with Starshipit', 500));
  } finally {
    await Order.updateOne({ _id: order._id }, { $unset: { shipmentLockUntil: 1 } }).catch(() => undefined);
  }
});

/** "Check Starshipit now": reads the order's tracking / label from Starshipit. Never buys a label. */
export const refreshShipment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id);
  if (!order) return next(new AppError('No order found with that ID', 404));
  if (!order.starshipitOrderId) return next(new AppError('This order is not in Starshipit yet.', 400));
  if (order.trackingSource === 'manual' && order.trackingNumber) {
    return next(new AppError('This order has tracking entered manually. Use Edit tracking to change it.', 400));
  }

  let d: Awaited<ReturnType<typeof starshipitService.readDetails>>;
  try {
    d = await starshipitService.readDetails(order.starshipitOrderId, { orderNumber: order.orderNumber, since: order.createdAt });
  } catch {
    return next(new AppError('Could not reach Starshipit. Nothing was changed — please try again in a minute.', 502));
  }
  if (!d) {
    // Not open and not in the shipped list: printed in Starshipit but never manifested — typically a
    // plain label, which has no tracking number. Nothing to sync; the admin finishes it by hand.
    return res.status(200).json({
      success: true,
      message: order.trackingNumber
        ? 'Up to date. Starshipit no longer lists this order as open or shipped.'
        : 'Starshipit shows no tracking number for this order yet. If it was printed there without one (for example a plain label), add the tracking manually or mark the order as fulfilled.',
      data: { order },
    });
  }
  if (d.archived && !order.trackingNumber) {
    return res.status(200).json({ success: true, message: 'This order is archived in Starshipit, so nothing was synced. Create the label in Starshipit, or add the tracking manually.', data: { order } });
  }

  const hadTracking = Boolean(order.trackingNumber);
  const savedTracking = order.trackingNumber;
  await applyStarshipitDetails(order, d, order.shipmentStatus || LABEL_PENDING_STATUS);
  // Starshipit now shows a different tracking number than the one we saved: a second label was made.
  // (The saved number is kept, as before — this only flags it.)
  if (savedTracking && d.trackingNumber && d.trackingNumber !== savedTracking && order.trackingSource !== 'manual') {
    const flagged = await recordLabelDuplicate(order._id, {
      reason: 'second_tracking',
      trackingNumbers: [savedTracking, d.trackingNumber],
      starshipitOrderIds: [order.starshipitOrderId],
    });
    if (flagged) order.labelDuplicate = flagged.labelDuplicate;
  }
  res.status(200).json({
    success: true,
    message: order.trackingNumber
      ? (hadTracking ? 'Up to date with Starshipit.' : 'Label found in Starshipit — tracking added.')
      : 'Checked Starshipit: no label yet. Print it in Starshipit — the tracking syncs back here automatically.',
    data: { order },
  });
});

/**
 * POST /api/admin/order/:id/label-duplicate/resolve
 * The team checked the possible duplicate label (kept the one on the parcel, refunded the rest):
 * hides the warning. The same evidence never re-opens it; a new tracking number / Starshipit order does.
 */
export const resolveLabelDuplicate = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id).select('labelDuplicate orderNumber');
  if (!order) return next(new AppError('No order found with that ID', 404));
  if (!order.labelDuplicate?.detectedAt) return next(new AppError('This order has no duplicate label warning.', 400));
  if (!order.labelDuplicate.resolvedAt) {
    const by = adminLabelOf((req as any).user).slice(0, 120);
    await Order.updateOne({ _id: order._id }, { $set: { 'labelDuplicate.resolvedAt': new Date(), 'labelDuplicate.resolvedBy': by } });
  }
  const updated = await Order.findById(order._id).select('labelDuplicate').lean();
  res.status(200).json({ success: true, message: 'Duplicate label warning marked as resolved.', data: { labelDuplicate: (updated as any)?.labelDuplicate } });
});

/** Why tracking can't be added to this order yet (null = it can). Editing existing tracking is always allowed. */
function manualTrackingBlockReason(order: any): string | null {
  if (order.isDeleted) return 'This order is deleted. Restore it first.';
  if (order.source === 'shopify_import' || order.tags?.includes('shopify-import')) return 'Historical Shopify orders cannot be changed.';
  if (order.trackingNumber) return null; // correcting tracking that is already there
  if (order.status === 'cancelled' || ['cancelled', 'failed', 'refunded'].includes(order.paymentStatus)) {
    return 'This order is cancelled or refunded, so it cannot be shipped.';
  }
  if (isBankMethod(order.paymentMethod) && !['paid', 'partially_refunded'].includes(order.paymentStatus)) {
    return 'Mark the order as paid first.';
  }
  // tagadaPaymentStatus: legacy (retired TagadaPay checkout) — an unpaid legacy card order stays blocked
  if (order.source !== 'admin_manual' && (order.paymentStatus === 'pending' || order.tagadaPaymentStatus === 'pending')) {
    return 'Payment is still pending.';
  }
  return null;
}

const TRACKING_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{3,49}$/;

/**
 * POST /api/admin/order/:id/tracking
 *
 * Enter or correct the tracking number by hand, for a label made outside Starshipit (e.g. directly
 * in Australia Post) or to fix the number on an order that already has a label. Saved as
 * trackingSource "manual", so the Starshipit webhook / refresh no longer overwrites it.
 * Body: { trackingNumber, trackingCarrier?, trackingUrl?, stage?, markFulfilled? = true, notifyCustomer? }
 *  - stage: label_created | in_transit | out_for_delivery | delivered (Starshipit can't track a
 *    number it didn't create, so the admin sets the delivery status of manual tracking)
 *  - notifyCustomer: sends the "your order has shipped" email; the first time at most once
 *    (same guard as Starshipit), again only when asked for explicitly
 */
export const updateManualTracking = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id);
  if (!order) return next(new AppError('No order found with that ID', 404));

  const blocked = manualTrackingBlockReason(order);
  if (blocked) return next(new AppError(blocked, 400));

  const body = req.body || {};
  const trackingNumber = String(body.trackingNumber ?? '').trim().replace(/\s+/g, ' ');
  if (!TRACKING_NUMBER_RE.test(trackingNumber)) {
    return next(new AppError('Enter a valid tracking number (letters, numbers, spaces or dashes).', 400));
  }
  const carrier = String(body.trackingCarrier ?? '').trim().slice(0, 60) || 'Australia Post';
  const rawUrl = String(body.trackingUrl ?? '').trim();
  if (rawUrl) {
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(rawUrl).protocol); } catch { ok = false; }
    if (!ok || rawUrl.length > 500) return next(new AppError('The tracking link must be a web address starting with https://', 400));
  }
  const stage: DeliveryStage | undefined = body.stage === undefined || body.stage === '' ? undefined : body.stage;
  if (stage && !MANUAL_STAGES.includes(stage)) return next(new AppError('Invalid delivery status.', 400));
  const markFulfilled = body.markFulfilled !== false;
  const notifyCustomer = body.notifyCustomer === true;

  const prevNumber = order.trackingNumber;
  const numberChanged = prevNumber !== trackingNumber;
  const now = new Date();

  order.trackingNumber = trackingNumber;
  order.trackingCarrier = carrier;
  order.trackingUrl = buildTrackingUrl(carrier, trackingNumber, rawUrl || undefined);
  order.trackingSource = 'manual';
  order.starshipitTrackingMisses = undefined;

  if (numberChanged) {
    // A different parcel: its delivery progress starts again
    order.tracking = {};
    order.shipmentStatus = 'Tracking added manually';
    applyTrackingStage(order, stage || 'label_created', now, { force: true });
  } else if (stage && order.tracking?.stage !== stage) {
    applyTrackingStage(order, stage, now, { force: true });
  }

  if (markFulfilled && order.status !== 'delivered') {
    order.status = 'shipped';
    order.fulfilmentStatus = 'fulfilled';
    if (!order.shippedAt) order.shippedAt = now;
  }

  const by = adminLabelOf((req as any).user);
  const notes: string[] = [];
  if (!prevNumber) notes.push(`Tracking number ${trackingNumber} (${carrier}) added manually by ${by}.`);
  else if (numberChanged) notes.push(`Tracking number changed from ${prevNumber} to ${trackingNumber} (${carrier}) by ${by}.`);
  if (stage && !numberChanged) notes.push(`Delivery status set to "${STAGE_LABELS[stage] || stage}" by ${by}.`);
  if (!notes.length) notes.push(`Tracking details for ${trackingNumber} updated by ${by}.`);
  order.comments = [...(order.comments || []), ...notes.map((text) => ({ text, createdAt: now }))];

  await order.save();

  let emailSent = false;
  let emailError = '';
  if (notifyCustomer) {
    if (!order.shipmentEmailSentAt) {
      emailSent = await sendShipmentEmailOnce(order);
      if (!emailSent) emailError = 'The shipping email could not be sent.';
    } else {
      try {
        await sendShipmentConfirmationEmail(order);
        await Order.updateOne({ _id: order._id }, { $set: { shipmentEmailSentAt: new Date() } });
        emailSent = true;
      } catch (err: any) {
        console.error(`[Manual tracking] shipping email failed for ${order.orderNumber ?? order._id}:`, err?.message ?? err);
        emailError = 'The shipping email could not be sent.';
      }
    }
    if (emailSent) {
      await Order.updateOne({ _id: order._id }, {
        $push: { comments: { text: `Shipping email with tracking ${trackingNumber} sent to ${customerEmailOf(order) || 'the customer'} by ${by}.`, createdAt: new Date() } },
      });
    }
  }

  const fresh = await Order.findById(order._id).lean();
  res.status(200).json({
    success: true,
    message: emailSent
      ? 'Tracking saved and the shipping email was sent to the customer.'
      : emailError ? `Tracking saved. ${emailError}` : 'Tracking saved.',
    data: { order: fresh, emailSent },
  });
});

const MILESTONES: Array<{ key: DeliveryStage; label: string; field: string }> = [
  { key: 'label_created', label: 'Label Created', field: 'labelCreatedAt' },
  { key: 'in_transit', label: 'In Transit', field: 'inTransitAt' },
  { key: 'out_for_delivery', label: 'Out for Delivery', field: 'outForDeliveryAt' },
  { key: 'delivered', label: 'Delivered', field: 'deliveredAt' },
];

// Orders list tracking refresh: how stale an order's scans may be before the list re-reads them,
// how many orders one call checks, and the time it may take (Starshipit allows ~2 requests/second).
const LIST_SYNC_STALE_MS = 10 * 60 * 1000;
const LIST_SYNC_MAX_ORDERS = 20;
const LIST_SYNC_BUDGET_MS = 15 * 1000;
const listSyncInProgress = new Set<string>();

/**
 * POST /api/admin/order/tracking-sync   body: { ids: string[] }
 *
 * Called by the Orders list right after it loads: re-reads the carrier scans of the shown orders
 * that are on their way (Starshipit label, not delivered, not checked in the last 10 minutes) and
 * returns their new Delivery Status, so the list is current without opening each order.
 * Delivery stage only (like the order page) — marking orders shipped / the shipment email stay with
 * the webhook and the scheduled refresh. Read-only towards Starshipit.
 */
export const syncOrdersTracking = catchAsync(async (req: Request, res: Response) => {
  const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = raw.filter((v: unknown) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v)).slice(0, 100);
  if (!ids.length) return res.status(200).json({ success: true, data: { updated: [], pending: 0 } });

  const staleBefore = new Date(Date.now() - LIST_SYNC_STALE_MS);
  const orders = await Order.find({
    _id: { $in: ids },
    isDeleted: { $ne: true },
    starshipitOrderId: { $exists: true, $nin: [null, ''] },
    trackingNumber: { $exists: true, $nin: [null, ''] },
    trackingSource: { $ne: 'manual' },
    'tracking.stage': { $ne: 'delivered' },
    shipmentStatus: { $not: /delivered/i },
    $or: [{ starshipitCheckedAt: { $exists: false } }, { starshipitCheckedAt: null }, { starshipitCheckedAt: { $lt: staleBefore } }],
  }).sort({ starshipitCheckedAt: 1 });

  const started = Date.now();
  const updated: Array<{ _id: string; delivery: ReturnType<typeof deliverySummary> }> = [];
  let checked = 0;
  for (const order of orders) {
    if (checked >= LIST_SYNC_MAX_ORDERS || Date.now() - started > LIST_SYNC_BUDGET_MS) break;
    const id = String(order._id);
    if (listSyncInProgress.has(id)) continue; // another admin's list is checking it right now
    listSyncInProgress.add(id);
    try {
      checked++;
      const r = await syncCarrierScans(order);
      await Order.updateOne({ _id: order._id }, { $set: { starshipitCheckedAt: new Date() } });
      if (r.changed) updated.push({ _id: id, delivery: deliverySummary(order) });
    } catch (err: any) {
      console.warn(`[Tracking] list refresh failed for order ${order.orderNumber ?? id}: ${err?.message}`);
    } finally {
      listSyncInProgress.delete(id);
    }
  }
  res.status(200).json({ success: true, data: { updated, checked, pending: Math.max(0, orders.length - checked) } });
});

/**
 * GET /api/admin/order/:id/tracking
 *
 * Delivery timeline for the order page: the 4 milestones (Label Created → In Transit → Out for
 * Delivery → Delivered) with their dates, the current status, and the carrier scan history.
 * Starshipit labels: carrier events from Starshipit (cached 10 min), which also move the stage on.
 * Manual tracking: the stage the admin set (Starshipit can't track numbers it didn't create).
 */
export const getOrderTracking = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id);
  if (!order) return next(new AppError('No order found with that ID', 404));

  const source = order.trackingSource || (order.trackingNumber ? 'starshipit' : undefined);
  const live = Boolean(order.trackingNumber && source !== 'manual' && order.starshipitOrderId);
  // Carrier scans (cached 10 min) move the stage on, forward only, with the carrier's own dates.
  // The scheduled refresh does the same for the Orders list (services/shipping/starshipitTracking.ts).
  const { events } = live ? await syncCarrierScans(order) : { events: [] as Array<{ datetime: string; status: string; details: string }> };

  const summary = deliverySummary(order);
  const t = order.tracking || {};
  // Highest milestone reached (exception / delayed keep the milestones reached before)
  let reached = MILESTONES.findIndex((m) => m.key === (t.stage || summary.stage));
  if (reached < 0) MILESTONES.forEach((m, i) => { if (t[m.field]) reached = i; });
  if (reached < 0 && order.trackingNumber && summary.stage !== 'label_pending') reached = 0;

  const milestones = MILESTONES.map((m, i) => ({
    key: m.key,
    label: m.label,
    date: t[m.field] || (i === 0 && reached >= 0 ? (order.shippedAt || null) : null),
    state: i < reached || (i === reached && m.key === 'delivered') ? 'done' : i === reached ? 'current' : 'pending',
  }));

  res.status(200).json({
    success: true,
    data: {
      source: source || null,
      trackingNumber: order.trackingNumber || '',
      trackingCarrier: order.trackingCarrier || '',
      trackingUrl: order.trackingUrl || '',
      summary,
      milestones,
      events: events.slice().reverse().slice(0, 30),
      live,
      lastUpdateAt: t.lastUpdateAt || null,
    },
  });
});

/**
 * POST /api/admin/orders/:id/refund
 *
 * Record a refund for an order. No payment provider is called: the money is returned outside the
 * admin (bank transfer / PayID, or — for legacy card orders from the retired TagadaPay checkout —
 * the card processor's own dashboard); this records it and updates the order's payment status.
 */
export const refundOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order: any = await Order.findById(req.params.id).lean();

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  if (order.source === 'shopify_import' || order.tags?.includes('shopify-import')) {
    return next(new AppError('Cannot process refunds for historical imported Shopify orders.', 400));
  }

  if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'partially_refunded') {
    return next(new AppError('Only paid or partially refunded orders can be refunded', 400));
  }

  // 1. Validate amount (finite, > 0, <= remaining, <= 2 dp; full refund only with full:true)
  const { amount, full, reason = 'Admin initiated refund' } = req.body ?? {};
  const v = validateRefundRequest({ amount, full, grandTotal: order.grandTotal ?? order.totalAmount, refundedAmount: order.refundedAmount });
  if (!v.ok) {
    return next(new AppError(v.error, v.status));
  }

  // 2. Atomic reservation — concurrent refunds cannot exceed the order total.
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

  // 3. Record-only: nothing to call — the refund is recorded as done.
  refund.status = 'succeeded';
  await refund.save();
  await confirmReservedRefund(order._id, v.amount);

  // 4. Payment status via the transition guard.
  const latest: any = await Order.findById(order._id).lean();
  await transitionPaymentStatus(order._id, refundTargetStatus(latest));
  const updated = await Order.findById(order._id).lean();

  res.status(200).json({
    success: true,
    // Legacy card order (retired TagadaPay checkout): the card payment is not reversed from here
    message: order.paymentMethod === 'tagada'
      ? 'Refund recorded. This order was paid by card through the retired TagadaPay checkout — the money must be returned to the customer outside the admin.'
      : 'Refund recorded',
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
    orderRequestId,
    couponCode,
  } = req.body;

  // Discount code used for this order (e.g. from an order request): recorded on the order so its
  // use is counted when the order is paid. The amount is the admin's discountTotal.
  let couponDoc: any = null;
  if (couponCode !== undefined && couponCode !== null && couponCode !== '') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { findDiscountByCode } = require('../../services/discounts/discountService');
    couponDoc = typeof couponCode === 'string' ? await findDiscountByCode(couponCode) : null;
    if (!couponDoc) return next(new AppError('Unknown discount code.', 400));
  }

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

  // 3. Resolve line items (variant by _id / sku; quantity 1..100)
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
        // Variants are not selectable in admin orders: an unmatched/missing key uses the primary (first) variant
        variant = (key && productDoc.variants.find((v: any) => String(v._id) === key || (v.sku && v.sku === key)))
          || productDoc.variants[0];
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
  const adminUser = (req as any).admin || (req as any).user;
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
    ...(couponDoc ? { couponCode: couponDoc.code, discountDescription: couponDoc.code } : {}),
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
    // Manual orders: the confirmation email (when the admin asked for it) is sent below, before the
    // response, so its timeline entry is there when the order opens; onOrderPaid never sends it.
    suppressConfirmationEmail: true,
    confirmationEmailOptOut: !sendEmail,
    // Stock is reserved below at creation, so onOrderPaid must not decrement again.
    inventoryDecrementedAt: now,
    source: 'admin_manual',
    createdByAdmin,
    adminNotes: String(notes).slice(0, 5000),
    comments: [{
      text: `Order created manually by ${adminLabelOf(adminUser)}. Payment status: ${isPaid ? 'Paid (manual)' : 'Pending'}.${sendEmail ? '' : ' Order confirmation email switched off.'}`,
      createdAt: now,
    }],
  }));

  // 7. Atomic stock decrement (manual orders reserve stock at creation, paid or not)
  const lowStock: LowStockCrossing[] = [];
  for (const line of stockLines) {
    try {
      const r = await decrementLineForOrder(order._id, line);
      if (r.ok && r.lowStock) lowStock.push(r.lowStock);
    } catch (err: any) {
      console.error(`[Admin Order] Stock decrement failed for order ${order._id}: ${err?.message}`);
    }
  }
  // Admin low-stock alert when this order took items to/below their threshold (never blocks)
  if (lowStock.length) {
    await Order.updateOne({ _id: order._id }, { $set: { lowStockAlert: { items: lowStock, at: new Date() } } }).catch(() => undefined);
    sendOrderLowStockAlert(order._id).catch((err: any) =>
      console.error(`[Admin Order] Low-stock alert failed for order ${order._id}: ${err?.message}`));
  }

  // 8. Trigger Google Address Validation asynchronously
  if (order.shippingAddressObj) {
    AddressValidationService.validateOrderAddress(order._id).catch((err: any) => {
      console.error('[Admin Order] Address Validation Error:', err?.message);
    });
  }

  // 9. "Send order confirmation email" ticked (paid or pending): send now, with its timeline entry
  if (sendEmail) {
    try {
      await sendConfirmationWithTimeline(order, sendOrderConfirmationEmail, adminLabelOf(adminUser));
    } catch (err: any) {
      console.error('[Admin Order] Failed to send order confirmation email:', err?.message);
      await Order.updateOne({ _id: order._id }, { $push: { comments: {
        text: `The order confirmation email could not be sent.${isPaid ? ' Use "Send confirmation email" to try again.' : ''}`,
        createdAt: new Date(),
      } } }).catch(() => undefined);
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

  // 11. Created from a storefront order request → mark the request handled and link the order
  if (typeof orderRequestId === 'string' && /^[0-9a-fA-F]{24}$/.test(orderRequestId)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrderRequest = require('../../models/OrderRequest').default;
    await OrderRequest.updateOne(
      { _id: orderRequestId, status: 'new' },
      { $set: { status: 'handled', orderId: order._id, handledAt: new Date() } }
    ).catch((err: any) => console.error(`[Admin Order] Could not link order request ${orderRequestId}: ${err?.message}`));
  }

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
/** Deleting an unpaid bank transfer / PayID order cancels it and gives its reserved stock back. */
async function cancelAndReleaseIfUnpaidBank(ids: unknown[]): Promise<void> {
  const unpaid = await Order.find({ _id: { $in: ids }, paymentStatus: 'pending', paymentMethod: { $in: ['payid', 'bank_transfer', 'international_bank_transfer'] } }).select('_id').lean();
  for (const o of unpaid) {
    try {
      const t = await transitionPaymentStatus(o._id, 'cancelled' as PaymentStatus);
      if (t.result === 'applied') {
        await releaseReservedStock(o._id);
        await releaseDiscountUse(o._id);
      }
    } catch (err: any) {
      console.error(`[Admin Order] Could not cancel/release deleted order ${o._id}: ${err?.message}`);
    }
  }
}

export const softDeleteOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  order.isDeleted = true;
  await order.save({ validateBeforeSave: false });
  await cancelAndReleaseIfUnpaidBank([order._id]);

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
  await cancelAndReleaseIfUnpaidBank(ids);

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


/**
 * GET /api/admin/order/requests/:id — a storefront order request, to pre-fill Create order.
 * Items include the product's current image, price and stock (or missing: true if it was deleted).
 */
export const getOrderRequestForAdmin = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return next(new AppError('Order request not found', 404));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OrderRequest = require('../../models/OrderRequest').default;
  const request: any = await OrderRequest.findById(id).lean();
  if (!request) return next(new AppError('Order request not found', 404));
  const products: any[] = await Product.find({ _id: { $in: (request.items || []).map((i: any) => i.product).filter(Boolean) } })
    .select('name sku price stockQuantity imageUrl images variants publishStatus').lean();
  const items = (request.items || []).map((i: any) => {
    const p = products.find((x) => String(x._id) === String(i.product));
    const v = p && i.variant ? (p.variants || []).find((x: any) => String(x._id) === String(i.variant)) : null;
    return {
      ...i,
      missing: !p || (i.variant && !v) ? true : undefined,
      productImageUrl: p ? (p.images?.[0]?.url || p.imageUrl || '') : '',
      stockQty: v ? v.stockQty : p?.stockQuantity,
      currentPrice: v ? v.price : p?.price,
    };
  });
  let order: any = null;
  if (request.orderId) order = await Order.findById(request.orderId).select('orderNumber').lean();
  res.status(200).json({ success: true, data: { request: { ...request, items }, order } });
});
