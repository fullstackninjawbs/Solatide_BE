import { Router } from 'express';
import {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/product.controller';
import { protect, restrictTo } from '../middleware/auth';

const router = Router();

// Public Routes
router.get('/', getAllProducts);
router.get('/:id', getProductById);

// Protected Admin-Only Routes
router.post('/', protect, restrictTo('admin'), createProduct);
router.patch('/:id', protect, restrictTo('admin'), updateProduct);
router.delete('/:id', protect, restrictTo('admin'), deleteProduct);

export default router;
