import { Request, Response, NextFunction } from 'express';
import Order from '../models/order.model';
import Product from '../models/product.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import { generateOrderNumber } from './payment.controller';

/**
 * Place a new Order.
 * Resolves prices from Database (client prices are not trusted) and aggregates total amount.
 */
export const createOrder = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { products, shippingAddress, customerEmail, customerName, paymentMethod } = req.body;

  if (!products || !Array.isArray(products) || products.length === 0) {
    return next(new AppError('Please provide a list of products for your order.', 400));
  }

  // Address collected via Tagada hosted checkout


  const orderItems = [];
  let totalAmount = 0;

  // 1) Verify products and calculate total
  for (const item of products) {
    const dbProduct = await Product.findById(item.product);
    if (!dbProduct) {
      return next(new AppError(`Product with ID ${item.product} not found.`, 404));
    }

    const canContinueSelling = dbProduct.inventoryPolicy === 'continue' || dbProduct.continueSellingWhenOutOfStock === true;
    const hasStock = dbProduct.inStock !== false && (dbProduct.stockQuantity > 0 || (dbProduct as any).stockQty > 0 || canContinueSelling);

    if (!hasStock && !canContinueSelling) {
      return next(new AppError(`Product '${dbProduct.name}' is out of stock.`, 400));
    }

    const price = dbProduct.price;
    const quantity = item.quantity || 1;
    totalAmount += price * quantity;

    orderItems.push({
      product: dbProduct._id as any,
      quantity,
      price,
    });
  }

  // 2) Create the order document
  const orderNumber = await generateOrderNumber();
  const newOrder = await Order.create({
    orderNumber,
    user: req.user?._id,
    products: orderItems,
    totalAmount,
    shippingAddress,
    customerEmail: customerEmail || '',
    customerName: customerName || '',
    paymentMethod: paymentMethod || undefined,
  });

  res.status(201).json({
    success: true,
    data: {
      order: newOrder,
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
 * Get a single order by ID.
 * Used by the checkout success page to display order confirmation.
 */
export const getOrderById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const order = await Order.findById(req.params.id);

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
 * Handle incoming webhooks from Starshipit to sync tracking details
 * Webhook sends data like: { order_number: '1004', reference: 'ORD-123', tracking_number: '...', carrier: '...', status: 'Dispatched' }
 */
export const handleStarshipitWebhook = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const payload = req.body;
  
  // Log the full payload for debugging to a file so we can inspect it!
  try {
    const fs = require('fs');
    fs.appendFileSync('webhook_payload.json', JSON.stringify(payload, null, 2) + ',\n');
  } catch (e) {}
  console.log('Starshipit Webhook Payload received and saved to webhook_payload.json');
  
  // Acknowledge receipt immediately to Starshipit
  res.status(200).json({ received: true });

  // Sometimes Starshipit nests the payload under an 'order' object
  const actualPayload = payload.order ? payload.order : payload;

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

    // Only update if a tracking number is present and we don't have it (or if it changed, though less likely)
    if (actualPayload.tracking_number && (!order.trackingNumber || order.trackingNumber !== actualPayload.tracking_number)) {
      order.trackingNumber = actualPayload.tracking_number;
      order.trackingCarrier = actualPayload.carrier_name || actualPayload.carrier || order.trackingCarrier || 'Unknown Carrier';
      order.shipmentStatus = 'in_transit';
      order.status = 'shipped'; // High level status
      
      // Auto-generate generic tracking URL if not provided by carrier rule
      if (!order.trackingUrl) {
        const carrier = order.trackingCarrier || '';
        if (carrier.toLowerCase().includes('auspost') || carrier.toLowerCase().includes('australia post')) {
          order.trackingUrl = `https://auspost.com.au/mypost/track/#/details/${payload.tracking_number}`;
        } else {
          order.trackingUrl = `https://www.google.com/search?q=${payload.tracking_number}`;
        }
      }
      
      await order.save();
      console.log(`Starshipit Webhook: Updated tracking for order ${payload.order_number}`);
    } else {
      // Just a status update without new tracking
      console.log(`Starshipit Webhook: Ignored non-tracking update for order ${payload.order_number}`);
    }
  } catch (error) {
    console.error('Starshipit Webhook Processing Error:', error);
  }
});
