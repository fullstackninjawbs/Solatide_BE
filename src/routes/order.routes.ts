import { Router } from 'express';
import {
  createOrder,
  getMyOrders,
  getAllOrders,
  updateOrderStatus,
} from '../controllers/order.controller';
import { protect, restrictTo } from '../middleware/auth';

const router = Router();

// Protect all routes
router.use(protect);

router.post('/', createOrder);
router.get('/my-orders', getMyOrders);

// Admin-Only Routes
router.get('/', restrictTo('admin'), getAllOrders);
router.patch('/:id/status', restrictTo('admin'), updateOrderStatus);

export default router;
