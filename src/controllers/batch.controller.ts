import { Request, Response, NextFunction } from 'express';
import Batch from '../models/batch.model';
import Product from '../models/product.model';
import catchAsync from '../utils/catchAsync';
import AppError from '../utils/appError';

export const getBatches = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const filter: any = {};

  // Optional filters
  if (req.query.status) filter.status = req.query.status;
  if (req.query.coaStatus) filter.coaStatus = req.query.coaStatus;
  if (req.query.productId) filter.productId = req.query.productId;

  const batches = await Batch.find(filter).populate('productId', 'name slug').sort('-createdAt');

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

/**
 * Helper: update currentBatchId on a specific variant (or variants[0] if no variantId given)
 */
const setCurrentBatchOnVariant = async (
  productId: any,
  batchId: any,
  variantId?: any
) => {
  const product = await Product.findById(productId);
  if (!product || !product.variants || product.variants.length === 0) return;

  if (variantId) {
    // Find the specific variant by its _id
    const variant = product.variants.find(v => (v as any)._id?.toString() === variantId.toString());
    if (variant) {
      (variant as any).currentBatchId = batchId;
    }
  } else {
    // Default to variants[0]
    (product.variants[0] as any).currentBatchId = batchId;
  }

  // Also keep root-level currentBatchId in sync (backward compat)
  (product as any).currentBatchId = batchId;

  await product.save();
};

export const createBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { setAsCurrent, ...batchData } = req.body;

  if (batchData.variantId === '') {
    batchData.variantId = null;
  }

  const newBatch = await Batch.create(batchData);

  // If requested, set as current batch for the variant (or product default)
  if (setAsCurrent && newBatch.productId) {
    await setCurrentBatchOnVariant(newBatch.productId, newBatch._id, newBatch.variantId);
  }

  res.status(201).json({
    success: true,
    data: { batch: newBatch }
  });
});

export const updateBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { setAsCurrent, ...batchData } = req.body;

  if (batchData.variantId === '') {
    batchData.variantId = null;
  }

  const batch = await Batch.findByIdAndUpdate(req.params.id, batchData, {
    new: true,
    runValidators: true
  });

  if (!batch) {
    return next(new AppError('No batch record found with that ID', 404));
  }

  // If requested, set as current batch for the variant
  if (setAsCurrent && batch.productId) {
    await setCurrentBatchOnVariant(batch.productId, batch._id, batch.variantId);
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

  // Clean up root-level and variant-level currentBatchId references
  if (batch.productId) {
    const product = await Product.findById(batch.productId);
    if (product) {
      if ((product as any).currentBatchId?.toString() === batch._id.toString()) {
        (product as any).currentBatchId = undefined;
      }
      if (product.variants) {
        product.variants.forEach(v => {
          if ((v as any).currentBatchId?.toString() === batch._id.toString()) {
            (v as any).currentBatchId = undefined;
          }
        });
      }
      await product.save();
    }
  }

  res.status(204).json({ success: true, data: null });
});
