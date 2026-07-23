import { Request, Response, NextFunction } from 'express';
import Batch from '../models/batch.model';
import Product from '../models/product.model';
import catchAsync from '../utils/catchAsync';
import AppError from '../utils/appError';
import { uploadImageBuffer } from '../utils/cloudinary';

const computeQcLevel = (tests: any) => {
  if (!tests) return 'none';
  
  // Requirement: at least HPLC purity must be performed to even be considered 'partial'
  // If not performed, we might reject the save earlier, but here we just return 'none'
  if (!tests.purityHplc?.performed) return 'none';

  // "Full panel" requires: purityHplc, netPeptideContent, identityHplc, endotoxinUsp85
  const isFull = 
    tests.purityHplc?.performed &&
    tests.netPeptideContent?.performed &&
    tests.identityHplc?.performed &&
    tests.endotoxinUsp85?.performed;
    
  return isFull ? 'full' : 'partial';
};

export const uploadCOA = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) {
    return next(new AppError('Please provide a COA file', 400));
  }

  const result = await uploadImageBuffer(req.file.buffer, 'solatide/coas');
  
  res.status(200).json({
    success: true,
    data: {
      url: result.secure_url,
      filename: req.file.originalname,
      uploadedAt: new Date()
    }
  });
});

export const getBatches = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const filter: any = {};

  // Optional filters
  if (req.query.status) filter.status = req.query.status;
  if (req.query.coaStatus) filter.coaStatus = req.query.coaStatus;
  if (req.query.productId) filter.productId = req.query.productId;

  if (req.query.search) {
    const searchRegex = new RegExp(req.query.search as string, 'i');
    const matchedProducts = await Product.find({ name: searchRegex }).select('_id');
    const matchedProductIds = matchedProducts.map(p => p._id);

    filter.$or = [
      { batchId: searchRegex },
      { displayName: searchRegex },
      { productId: { $in: matchedProductIds } }
    ];
  }

  // Pagination params
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 50;
  const skip = (page - 1) * limit;

  const total = await Batch.countDocuments(filter);
  const batches = await Batch.find(filter)
    .populate('productId', 'name slug')
    .sort('-createdAt')
    .skip(skip)
    .limit(limit);

  res.status(200).json({
    success: true,
    results: batches.length,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    data: {
      batches,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

export const getPublicCoas = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // Fetch active batches that have an approved COA document
  const filter: any = {
    status: 'active',
    $or: [
      { 'coaFile.url': { $exists: true, $ne: null } },
      { coaUrl: { $exists: true, $ne: null } }
    ]
  };

  const batches = await Batch.find(filter)
    .populate('productId', 'name slug')
    .sort('-createdAt');

  res.status(200).json({
    success: true,
    results: batches.length,
    data: { batches }
  });
});

export const proxyCoa = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return next(new AppError('Please provide a URL to proxy', 400));
  }
  
  const https = require('https');
  https.get(url, (cloudinaryRes: any) => {
    if (cloudinaryRes.statusCode !== 200) {
      return next(new AppError('Failed to fetch from Cloudinary', cloudinaryRes.statusCode || 500));
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="coa.pdf"');
    cloudinaryRes.pipe(res);
  }).on('error', (err: any) => {
    next(new AppError('Error proxying COA: ' + err.message, 500));
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

  if (!batchData.productId) return next(new AppError('Product ID is required', 400));
  if (!batchData.batchId) return next(new AppError('Batch ID is required', 400));


  if (batchData.variantId === '') {
    batchData.variantId = null;
  }

  batchData.qcLevel = computeQcLevel(batchData.tests);

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

  if (batchData.productId === '') return next(new AppError('Product ID is required', 400));
  if (batchData.batchId === '') return next(new AppError('Batch ID is required', 400));


  if (batchData.variantId === '') {
    batchData.variantId = null;
  }
  
  if (batchData.tests) {
    batchData.qcLevel = computeQcLevel(batchData.tests);
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
  } else if (setAsCurrent === false && batch.productId) {
    // Explicitly unchecked — remove this batch as current if it was set
    const product = await Product.findById(batch.productId);
    if (product) {
      let changed = false;

      // Clear root-level reference if it points to this batch
      if ((product as any).currentBatchId?.toString() === batch._id.toString()) {
        (product as any).currentBatchId = undefined;
        changed = true;
      }

      // Clear variant-level reference if it points to this batch
      if (product.variants) {
        product.variants.forEach(v => {
          if ((v as any).currentBatchId?.toString() === batch._id.toString()) {
            (v as any).currentBatchId = undefined;
            changed = true;
          }
        });
      }

      if (changed) await product.save();
    }
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
