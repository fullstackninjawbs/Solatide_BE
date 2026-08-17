import { Request, Response, NextFunction } from 'express';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import {
  previewTagadaProductSync,
  syncAllTagadaProducts,
  syncTagadaProduct,
  fetchTagadaProducts
} from '../../services/tagadaProductSync.service';
import TagadaProductSyncLog from '../../models/tagadaProductSyncLog.model';

// @desc    Get preview of Tagada sync (no DB writes)
// @route   GET /api/admin/tagada/products/sync-preview
// @access  Private/Admin
export const getSyncPreview = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const preview = await previewTagadaProductSync();
  
  res.status(200).json({
    success: true,
    data: preview
  });
});

// @desc    Run full sync from Tagada
// @route   POST /api/admin/tagada/products/sync
// @access  Private/Admin
export const runFullSync = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // Pass the user ID to record who initiated it
  const adminUserId = req.user?.id;
  
  const log = await syncAllTagadaProducts(adminUserId);
  
  res.status(200).json({
    success: true,
    data: log
  });
});

// @desc    Sync a single product by its Tagada ID
// @route   POST /api/admin/tagada/products/:tagadaProductId/sync
// @access  Private/Admin
export const syncSingleProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { tagadaProductId } = req.params;
  
  // Need to fetch this specific product from Tagada
  // If Tagada SDK has a retrieve method, we can use it:
  // const client = await getTagadaClient();
  // const raw = await client.products.retrieve(tagadaProductId);
  // For now, fetch all and find it (less efficient but works if retrieve isn't mapped)
  
  const products = await fetchTagadaProducts();
  const raw = products.find(p => p.id === tagadaProductId);

  if (!raw) {
    return next(new AppError(`Product with Tagada ID ${tagadaProductId} not found in Tagada`, 404));
  }

  const result = await syncTagadaProduct(raw);
  
  res.status(200).json({
    success: true,
    data: result
  });
});

// @desc    Get sync history logs
// @route   GET /api/admin/tagada/products/sync-history
// @access  Private/Admin
export const getSyncHistory = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const limit = parseInt(req.query.limit as string) || 20;
  
  const logs = await TagadaProductSyncLog.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('initiatedBy', 'name email');
    
  res.status(200).json({
    success: true,
    data: logs
  });
});
