import { Request, Response, NextFunction } from 'express';
import Order from '../models/order.model';
import Product from '../models/product.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';

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

    if (!dbProduct.inStock) {
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
  const newOrder = await Order.create({
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
