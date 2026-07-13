import { Request, Response, NextFunction } from 'express';
import Order from '../../models/order.model';
import Product from '../../models/product.model';
import StoreSettings from '../../models/StoreSettings';
import { starshipitService } from '../../services/shipping/starshipit.service';
import AppError from '../../utils/appError';
import catchAsync from '../../utils/catchAsync';

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
  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (fulfilmentStatus) filter.fulfilmentStatus = fulfilmentStatus;

  // Text search across orderNumber and customer.email
  if (q && q.trim()) {
    const escapedQ = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { orderNumber: { $regex: escapedQ, $options: 'i' } },
      { 'customer.email': { $regex: escapedQ, $options: 'i' } },
      { customerEmail: { $regex: escapedQ, $options: 'i' } },
      { customerName: { $regex: escapedQ, $options: 'i' } },
    ];
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
    pages: Math.ceil(total / limitNum),
    data: { orders },
  });
});

/**
 * GET /api/admin/orders/:id
 *
 * Full order detail — returns all fields.
 */
export const getOrderById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id).lean();

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  res.status(200).json({
    success: true,
    data: { order },
  });
});

/**
 * PATCH /api/admin/orders/:id/status
 *
 * Update status and/or fulfilmentStatus on an order.
 * Body: { status?, fulfilmentStatus?, adminNotes? }
 */
export const updateOrderStatus = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { status, fulfilmentStatus, adminNotes } = req.body;

  const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  const validFulfilment = ['unfulfilled', 'fulfilled', 'partial'];

  if (status && !validStatuses.includes(status)) {
    return next(new AppError(`Invalid status: ${status}`, 400));
  }
  if (fulfilmentStatus && !validFulfilment.includes(fulfilmentStatus)) {
    return next(new AppError(`Invalid fulfilmentStatus: ${fulfilmentStatus}`, 400));
  }

  const updateFields: Record<string, any> = {};
  if (status) updateFields.status = status;
  if (fulfilmentStatus) updateFields.fulfilmentStatus = fulfilmentStatus;
  if (adminNotes !== undefined) updateFields.adminNotes = adminNotes;

  if (Object.keys(updateFields).length === 0) {
    return next(new AppError('No valid fields to update', 400));
  }

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { $set: updateFields },
    { new: true, runValidators: false }
  ).lean();

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

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
  const { tags, comments, shippingAddressObj, billingAddressObj, adminNotes } = req.body;
  
  const updateFields: Record<string, any> = {};
  if (tags !== undefined) updateFields.tags = tags;
  if (comments !== undefined) updateFields.comments = comments;
  if (shippingAddressObj !== undefined) updateFields.shippingAddressObj = shippingAddressObj;
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

  if (order.paymentStatus !== 'paid') {
    return next(new AppError('Cannot create shipment for unpaid order', 400));
  }

  if (order.easyPostShipmentId || order.starshipitOrderId) {
    return next(new AppError('Shipment already created for this order', 400));
  }

  if (!order.shippingAddressObj) {
    return next(new AppError('Order missing shipping address', 400));
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

    // 2. Update Order
    order.starshipitOrderId = shippingResult.orderId;
    
    if (shippingResult.trackingNumber) {
      order.trackingNumber = shippingResult.trackingNumber;
    }
    if (shippingResult.trackingCarrier) {
      order.trackingCarrier = shippingResult.trackingCarrier;
    }
    if (shippingResult.labelUrl) {
      order.labelUrl = shippingResult.labelUrl;
    }
    
    order.status = 'processing';
    await order.save();

    res.status(200).json({
      success: true,
      data: { order },
    });
  } catch (error: any) {
    console.error('Starshipit Error:', error);
    return next(new AppError(error.message || 'Failed to create shipment with Starshipit', 500));
  }
});
