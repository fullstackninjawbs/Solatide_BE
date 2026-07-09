import { Request, Response, NextFunction } from 'express';
import Discount from '../../models/Discount';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';

// GET /api/admin/discount
export const getDiscounts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const search = req.query.search as string;
  const status = req.query.status as string;
  const filter: any = {};
  if (search) {
    filter.code = { $regex: search, $options: 'i' };
  }
  if (status && status !== 'all') {
    filter.status = status;
  }

  const discounts = await Discount.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Discount.countDocuments(filter);

  res.status(200).json({
    success: true,
    data: {
      discounts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

// GET /api/admin/discount/:id
export const getDiscountById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.findById(req.params.id);
  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }

  res.status(200).json({
    success: true,
    data: { discount }
  });
});

// POST /api/admin/discount
export const createDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.create(req.body);

  res.status(201).json({
    success: true,
    data: { discount }
  });
});

// PUT /api/admin/discount/:id
export const updateDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });

  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }

  res.status(200).json({
    success: true,
    data: { discount }
  });
});

// DELETE /api/admin/discount/:id
export const deleteDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.findByIdAndDelete(req.params.id);

  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }

  res.status(204).json({
    success: true,
    data: null
  });
});
