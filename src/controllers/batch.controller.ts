import { Request, Response, NextFunction } from 'express';
import Batch from '../models/batch.model';
import Product from '../models/product.model';
import catchAsync from '../utils/catchAsync';
import AppError from '../utils/appError';

export const getBatches = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const batches = await Batch.find().populate('productId', 'name slug').sort('-createdAt');
  
  res.status(200).json({
    success: true,
    results: batches.length,
    data: { batches }
  });
});

export const getBatchById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const batch = await Batch.findById(req.params.id).populate('productId', 'name slug');
  
  if (!batch) {
    return next(new AppError('No batch record found with that ID', 404));
  }
  
  res.status(200).json({
    success: true,
    data: { batch }
  });
});

export const createBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { setAsCurrent, ...batchData } = req.body;
  
  const newBatch = await Batch.create(batchData);
  
  // If requested, set as current batch for the associated product
  if (setAsCurrent && newBatch.productId) {
    await Product.findByIdAndUpdate(newBatch.productId, { currentBatchId: newBatch._id });
  }
  
  res.status(201).json({
    success: true,
    data: { batch: newBatch }
  });
});

export const updateBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { setAsCurrent, ...batchData } = req.body;
  
  const batch = await Batch.findByIdAndUpdate(req.params.id, batchData, {
    new: true,
    runValidators: true
  });
  
  if (!batch) {
    return next(new AppError('No batch record found with that ID', 404));
  }
  
  // If requested, set as current batch for the associated product
  if (setAsCurrent && batch.productId) {
    await Product.findByIdAndUpdate(batch.productId, { currentBatchId: batch._id });
  }
  
  res.status(200).json({
    success: true,
    data: { batch }
  });
});

export const deleteBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const batch = await Batch.findByIdAndDelete(req.params.id);
  
  if (!batch) {
    return next(new AppError('No batch record found with that ID', 404));
  }
  
  // Clean up if it was the current batch
  if (batch.productId) {
    await Product.updateMany(
      { currentBatchId: batch._id },
      { $unset: { currentBatchId: 1 } }
    );
  }
  
  res.status(204).json({
    success: true,
    data: null
  });
});
