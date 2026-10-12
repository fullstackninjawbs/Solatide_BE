import { Router } from 'express';
import {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteAllProducts,
  uploadProductImage,
  getPublicCollections,
} from '../controllers/product.controller';
import {
  importProductsPreview,
  importProductsCommit,
} from '../controllers/import.controller';
import { protect, restrictTo, optionalAuth } from '../middleware/auth';
import { ACCESS } from '../config/roles';
import { productImageUpload, spreadsheetUpload } from '../middleware/uploadFilters';

const router = Router();

// Public Routes. optionalAuth lets staff tokens see drafts / internal fields;
// anonymous and customer requests get the public (active-only) projection.
router.get('/collections', getPublicCollections);
router.get('/', optionalAuth, getAllProducts);
router.get('/:id', optionalAuth, getProductById);

// Protected Admin/Operations CSV Importer Routes
router.post(
  '/import/preview',
  protect,
  restrictTo(...ACCESS.productImport),
  spreadsheetUpload.single('file'),
  importProductsPreview
);

router.post(
  '/import/commit',
  protect,
  restrictTo(...ACCESS.productImport),
  spreadsheetUpload.single('file'),
  importProductsCommit
);

// Protected Admin/Operations Product CRUD Routes
router.post('/', protect, restrictTo(...ACCESS.productImport), createProduct);
router.patch('/:id', protect, restrictTo(...ACCESS.productImport), updateProduct);
router.delete('/', protect, restrictTo(...ACCESS.publicProductDelete), deleteAllProducts);
router.delete('/:id', protect, restrictTo(...ACCESS.publicProductDelete), deleteProduct);

// Upload Image Route
router.post('/upload-image', protect, restrictTo(...ACCESS.productImport), productImageUpload.single('file'), uploadProductImage);

export default router;
