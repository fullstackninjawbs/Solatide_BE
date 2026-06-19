import { Router } from 'express';
import multer from 'multer';
import {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/product.controller';
import {
  importProductsPreview,
  importProductsCommit,
} from '../controllers/import.controller';
import { protect, restrictTo } from '../middleware/auth';

const router = Router();

// Multer memory storage configuration for file stream parsing
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Capped at 10MB to prevent heap overflow
  },
});

// Public Routes
router.get('/', getAllProducts);
router.get('/:id', getProductById);

// Protected Admin/Operations CSV Importer Routes
router.post(
  '/import/preview',
  protect,
  restrictTo('super_admin', 'operations', 'admin'),
  upload.single('file'),
  importProductsPreview
);

router.post(
  '/import/commit',
  protect,
  restrictTo('super_admin', 'operations', 'admin'),
  upload.single('file'),
  importProductsCommit
);

// Protected Admin/Operations Product CRUD Routes
router.post('/', protect, restrictTo('super_admin', 'operations', 'admin'), createProduct);
router.patch('/:id', protect, restrictTo('super_admin', 'operations', 'admin'), updateProduct);
router.delete('/:id', protect, restrictTo('super_admin', 'admin'), deleteProduct);

export default router;
