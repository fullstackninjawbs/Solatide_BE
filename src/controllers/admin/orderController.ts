import { Request, Response, NextFunction } from 'express';
import Order from '../../models/order.model';
import Product from '../../models/product.model';
import StoreSettings from '../../models/StoreSettings';
import { starshipitService } from '../../services/shipping/starshipit.service';
import { sendShipmentConfirmationEmail } from '../../services/emailService';
import AppError from '../../utils/appError';
import catchAsync from '../../utils/catchAsync';
import { getTagadaClient } from '../../services/tagadaClient';
import config from '../../config';
import Refund from '../../models/Refund';
import Customer from '../../models/Customer';
import { generateOrderNumber } from '../payment.controller';
import AddressValidationService from '../../services/addressValidation.service';

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

  res.status(200).json({
    success: true,
    data: { order: order.toObject ? order.toObject() : order },
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
    console.error('Starshipit Error:', error);
    return next(new AppError(error.message || 'Failed to create shipment with Starshipit', 500));
  }
});

/**
 * POST /api/admin/orders/:id/refund
 *
 * Process a refund for an order. If paid via Tagada, it calls the Tagada API.
 */
export const refundOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('No order found with that ID', 404));
  }

  // 1. Test Environment Guard
  if (config.tagadaEnv !== 'sandbox' || (order.tagadaEnv && order.tagadaEnv !== 'sandbox')) {
    return next(new AppError('Refunds are only permitted in the TEST (sandbox) environment for this funnel.', 403));
  }

  if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunded') {
    return next(new AppError('Order is not paid, cannot refund', 400));
  }

  if (order.refundStatus === 'refunded') {
    return next(new AppError('Order is already fully refunded', 400));
  }

  const { amount, reason = 'Admin initiated refund', type } = req.body;
  const requestedAmount = amount ? Number(amount) : (order.grandTotal || 0);

  // Validate amount
  const maxRefundable = (order.grandTotal || 0) - (order.refundedAmount || 0);
  if (requestedAmount > maxRefundable) {
    return next(new AppError(`Refund amount (${requestedAmount}) exceeds the maximum refundable amount (${maxRefundable}).`, 400));
  }

  const refundType = type || (requestedAmount === order.grandTotal ? 'full' : 'partial');

  try {
    // If the payment method was Tagada, process it via API
    if (order.paymentMethod === 'tagada') {
      const tagadaId = order.tagadaPaymentId;
      if (!tagadaId) {
        return next(new AppError('No Tagada Payment ID found for this order', 400));
      }

      const client = await getTagadaClient();

      if (typeof client.payments?.refund === 'function') {
        const payload: any = {
          paymentIds: [tagadaId],
          metadata: { reason }
        };
        // For partial refunds, pass the specific amount. 
        // For full refunds, omit amount to let Tagada refund the whole remaining balance.
        if (refundType === 'partial') {
          payload.amount = requestedAmount;
          // Note: if Tagada requires cents, we may need to multiply by 100 here.
        }
        await client.payments.refund(payload);
      } else {
        console.warn('TagadaClient does not natively expose payments.refund(). Cannot process refund.');
        return next(new AppError('Tagada SDK does not support refunds in this version.', 500));
      }
    }

    // Create refund record directly as succeeded since the API call didn't throw an error
    const refund = await Refund.create({
      order: order._id,
      amount: requestedAmount,
      reason,
      type: refundType,
      status: 'succeeded'
    });

    // Update order internally
    order.refundedAmount = (order.refundedAmount || 0) + requestedAmount;
    if (refundType === 'full' || order.refundedAmount >= (order.grandTotal || 0)) {
      order.refundStatus = 'refunded';
    } else {
      order.refundStatus = 'partially_refunded';
    }
    await order.save({ validateBeforeSave: false });

    res.status(200).json({
      success: true,
      message: 'Refund initiated successfully',
      data: { order, refund },
    });
  } catch (error: any) {
    console.error('Refund Error:', error);
    return next(new AppError(error?.response?.data?.message || error.message || 'Failed to process refund via TagadaPay', 500));
  }
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
  } = req.body;

  // 1. Basic validation
  if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
    return next(new AppError('At least one line item is required to create an order.', 400));
  }

  const email = customer?.email?.trim();
  if (!email) {
    return next(new AppError('Customer email is required.', 400));
  }

  // 2. Resolve or create Customer record
  let customerDoc: any = null;
  if (customerId) {
    customerDoc = await Customer.findById(customerId);
  }
  if (!customerDoc) {
    customerDoc = await Customer.findOne({ email: email.toLowerCase() });
  }

  const customerName = `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || 'Guest Customer';

  if (!customerDoc) {
    customerDoc = await Customer.create({
      name: customerName,
      email: email.toLowerCase(),
      phone: customer?.phone || '',
      defaultAddress: shippingAddressObj || billingAddressObj || {},
      country: shippingAddressObj?.country || 'AU',
      orderCount: 0,
      totalSpent: 0,
    });
  }

  // 3. Process line items & stock decrement
  const processedLineItems = [];
  let calculatedSubtotal = 0;

  for (const item of lineItems) {
    if (!item.productId && !item.title) {
      return next(new AppError('Line item must include a valid product or title.', 400));
    }

    let productDoc: any = null;
    if (item.productId) {
      productDoc = await Product.findById(item.productId);
    }

    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
    let unitPrice = typeof item.unitPrice === 'number' ? item.unitPrice : parseFloat(item.unitPrice || '0');
    let title = item.title || productDoc?.name || 'Item';
    let variantTitle = item.variantTitle || '';
    let sku = item.sku || productDoc?.sku || '';
    let productImageUrl = item.productImageUrl || productDoc?.images?.[0] || productDoc?.image || '';

    // Handle stock & pricing from product if available
    if (productDoc) {
      title = productDoc.name;

      if (item.variantId && Array.isArray(productDoc.variants) && productDoc.variants.length > 0) {
        const variant = productDoc.variants.find((v: any) => v._id?.toString() === item.variantId || v.sku === item.variantId);
        if (variant) {
          variantTitle = variant.name || variantTitle;
          sku = variant.sku || sku;
          if (unitPrice === 0 && variant.price) {
            unitPrice = typeof variant.price === 'string' ? parseFloat(variant.price.replace(/[^0-9.]/g, '')) : variant.price;
          }

          // Decrement variant stock
          if (typeof variant.stockQty === 'number') {
            variant.stockQty = Math.max(0, variant.stockQty - qty);
          }
        }
      }

      if (unitPrice === 0 && productDoc.price) {
        unitPrice = typeof productDoc.price === 'string' ? parseFloat(productDoc.price.replace(/[^0-9.]/g, '')) : productDoc.price;
      }

      // Decrement product overall stock quantity
      if (Array.isArray(productDoc.variants) && productDoc.variants.length > 0) {
        productDoc.stockQuantity = productDoc.variants.reduce((sum: number, v: any) => sum + (v.stockQty || 0), 0);
      } else if (typeof productDoc.stockQuantity === 'number') {
        productDoc.stockQuantity = Math.max(0, productDoc.stockQuantity - qty);
      }
      productDoc.inStock = (productDoc.stockQuantity || 0) > 0;
      await productDoc.save({ validateBeforeSave: false });
    }

    const lineDiscount = Math.max(0, parseFloat(item.discountAmount || 0));
    const lineSubtotal = Math.max(0, (unitPrice * qty) - lineDiscount);

    calculatedSubtotal += lineSubtotal;

    processedLineItems.push({
      title,
      variantTitle,
      sku,
      quantity: qty,
      unitPrice,
      subtotal: lineSubtotal,
      productImageUrl,
    });
  }

  // 4. Financial calculations
  const parsedShippingCost = Math.max(0, parseFloat(shippingCost) || 0);
  const parsedDiscountTotal = Math.max(0, parseFloat(discountTotal) || 0);
  const grandTotal = Math.max(0, calculatedSubtotal - parsedDiscountTotal + parsedShippingCost);

  // 5. Generate Order Number
  const orderNumber = await generateOrderNumber();

  // 6. Admin user credentials (audit log)
  const adminUser = (req as any).admin;
  const createdByAdmin = adminUser ? {
    id: adminUser._id?.toString() || adminUser.id,
    email: adminUser.email,
    name: adminUser.name || adminUser.email
  } : undefined;

  // 7. Create Order document
  const isPaid = paymentStatus === 'paid';
  const order = await Order.create({
    orderNumber,
    customer: {
      firstName: customer?.firstName || customerDoc.name?.split(' ')[0] || '',
      lastName: customer?.lastName || customerDoc.name?.split(' ').slice(1).join(' ') || '',
      email: email.toLowerCase(),
      phone: customer?.phone || customerDoc.phone || '',
    },
    customerEmail: email.toLowerCase(),
    customerName,
    shippingAddressObj: shippingAddressObj || billingAddressObj || {},
    billingAddressObj: billingAddressObj || shippingAddressObj || {},
    shippingAddress: shippingAddressObj ? `${shippingAddressObj.street1 || ''}, ${shippingAddressObj.city || ''} ${shippingAddressObj.state || ''} ${shippingAddressObj.zip || ''} ${shippingAddressObj.country || ''}` : '',
    lineItems: processedLineItems,
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
    source: 'admin_manual',
    createdByAdmin,
    adminNotes: notes,
    comments: [{
      text: `Order created manually by admin (${adminUser?.email || 'admin'}). Payment status: ${isPaid ? 'Paid (manual)' : 'Pending'}.`,
      createdAt: new Date(),
    }],
  });

  // 8. Update Customer lifetime statistics
  customerDoc.orderCount = (customerDoc.orderCount || 0) + 1;
  if (isPaid) {
    customerDoc.totalSpent = (customerDoc.totalSpent || 0) + grandTotal;
  }
  await customerDoc.save({ validateBeforeSave: false });

  // 9. Trigger Google Address Validation asynchronously
  if (order.shippingAddressObj) {
    AddressValidationService.validateOrderAddress(order._id).catch(err => {
      console.error('[Admin Order] Address Validation Error:', err);
    });
  }

  res.status(201).json({
    success: true,
    message: 'Manual order created successfully',
    data: { order },
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
