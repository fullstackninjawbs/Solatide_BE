import { Request, Response, NextFunction } from 'express';
import Customer from '../../models/Customer';
import Order from '../../models/order.model';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';

// GET /api/admin/customers
export const getCustomers = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  // Basic searching by name or email
  const search = req.query.search as string;
  const filter: any = {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } }
    ];
  }

  const customers = await Customer.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Customer.countDocuments(filter);

  res.status(200).json({
    success: true,
    data: {
      customers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

// GET /api/admin/customers/:id
export const getCustomerById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  // Fetch their full order history
  const orders = await Order.find({ 
    $or: [
      { customerEmail: customer.email },
      { 'customer.email': customer.email }
    ]
  }).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    data: {
      customer,
      orders
    }
  });
});

// PUT /api/admin/customers/:id
export const updateCustomer = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { name, email, phone, defaultAddress, country, tags, banned, comments } = req.body;
  
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { name, email, phone, defaultAddress, country, tags, banned, comments },
    { new: true, runValidators: true }
  );

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    data: {
      customer
    }
  });
});
