import { Request, Response, NextFunction } from 'express';
import Batch from '../models/batch.model';
import Product from '../models/product.model';
import catchAsync from '../utils/catchAsync';
import AppError from '../utils/appError';
import { uploadImageBuffer } from '../utils/cloudinary';
import { cacheDel } from '../utils/cache';
import { escapeRegex } from '../utils/collectionUtils';
import { fetchCloudinaryCoa } from '../utils/coaProxy';

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
  // Conditions that each need their own $or are combined with $and (they used to overwrite
  // each other when a product filter and a search were used together)
  const and: any[] = [];
  if (req.query.productId) {
    and.push({ $or: [
      { productId: req.query.productId },
      { products: req.query.productId }
    ] });
  }
  // COA screen: only batches that have a COA document attached
  if (req.query.hasCoa === 'true') {
    and.push({ $or: [
      { 'coaFile.url': { $exists: true, $nin: [null, ''] } },
      { coaUrl: { $exists: true, $nin: [null, ''] } }
    ] });
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    const matchedProducts = await Product.find({ name: searchRegex }).select('_id');
    const matchedProductIds = matchedProducts.map(p => p._id);

    and.push({ $or: [
      { batchId: searchRegex },
      { displayName: searchRegex },
      { productId: { $in: matchedProductIds } },
      { products: { $in: matchedProductIds } }
    ] });
  }
  if (and.length) filter.$and = and;

  // Pagination params
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
  const skip = (page - 1) * limit;

  const total = await Batch.countDocuments(filter);
  const batches = await Batch.find(filter)
    .populate('productId', 'name slug')
    .populate('products', 'name slug')
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
    status: 'active'
  };

  const batches = await Batch.find(filter)
    .populate('productId', 'name slug')
    .populate('products', 'name slug')
    .sort('-createdAt');

  res.status(200).json({
    success: true,
    results: batches.length,
    data: { batches }
  });
});

/**
 * GET /api/admin/batches/proxy-coa?url=
 * Streams a COA document from this account's Cloudinary only (SSRF-hardened, see utils/coaProxy.ts).
 */
export const proxyCoa = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return next(new AppError('Please provide a URL to proxy', 400));
  }
  const result = await fetchCloudinaryCoa(url);
  if (!result.ok) {
    return next(new AppError(result.message, result.status));
  }
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', 'inline; filename="coa' + (result.contentType === 'application/pdf' ? '.pdf' : '') + '"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(result.body);
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

  product.markModified('variants');
  await product.save();
};

export const createBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { setAsCurrent, ...batchData } = req.body;

  if (!batchData.productId && (!batchData.products || batchData.products.length === 0)) return next(new AppError('Product ID is required', 400));
  if (!batchData.batchId) return next(new AppError('Batch ID is required', 400));


  if (batchData.variantId === '') {
    batchData.variantId = null;
  }

  batchData.qcLevel = computeQcLevel(batchData.tests);

  const newBatch = await Batch.create(batchData);

  // Always set as current batch for the variant (or product default)
  const pIds = newBatch.products && newBatch.products.length > 0 ? newBatch.products : (newBatch.productId ? [newBatch.productId] : []);
  for (const pId of pIds) {
    await setCurrentBatchOnVariant(pId, newBatch._id, newBatch.variantId);
    
    // Invalidate product cache
    const product = await Product.findById(pId).select('slug');
    if (product) {
      await cacheDel(`products:detail:${product.slug}`);
      await cacheDel(`products:detail:${product.id}`);
      await cacheDel(`products:detail:${product._id}`);
    }
  }
  
  await cacheDel('products:list*');

  res.status(201).json({
    success: true,
    data: { batch: newBatch }
  });
});

export const updateBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { setAsCurrent, ...batchData } = req.body;

  if (batchData.productId === '' && (!batchData.products || batchData.products.length === 0)) return next(new AppError('Product ID is required', 400));
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

  // Always set as current batch for the variant
  const pIds = batch.products && batch.products.length > 0 ? batch.products : (batch.productId ? [batch.productId] : []);
  if (pIds.length > 0) {
    for (const pId of pIds) {
      await setCurrentBatchOnVariant(pId, batch._id, batch.variantId);
      
      // Invalidate product cache
      const product = await Product.findById(pId).select('slug');
      if (product) {
        await cacheDel(`products:detail:${product.slug}`);
        await cacheDel(`products:detail:${product.id}`);
        await cacheDel(`products:detail:${product._id}`);
      }
    }
  }
  
  await cacheDel('products:list*');
  
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
  const pIds = batch.products && batch.products.length > 0 ? batch.products : (batch.productId ? [batch.productId] : []);
  for (const pId of pIds) {
    const product = await Product.findById(pId);
    if (product) {
      let changed = false;
      if ((product as any).currentBatchId?.toString() === batch._id.toString()) {
        (product as any).currentBatchId = undefined;
        changed = true;
      }
      if (product.variants) {
        product.variants.forEach(v => {
          if ((v as any).currentBatchId?.toString() === batch._id.toString()) {
            (v as any).currentBatchId = undefined;
            changed = true;
          }
        });
      }
      if (changed) {
        product.markModified('variants');
        await product.save();
        await cacheDel(`products:detail:${product.slug}`);
        await cacheDel(`products:detail:${product.id}`);
        await cacheDel(`products:detail:${product._id}`);
      }
    }
  }

  await cacheDel('products:list*');

  res.status(204).json({ success: true, data: null });
});
