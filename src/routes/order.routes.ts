import { Router } from 'express';
import {
  createOrder,
  getMyOrders,
  getAllOrders,
  updateOrderStatus,
} from '../controllers/order.controller';
import { protect, restrictTo, optionalAuth } from '../middleware/auth';

const router = Router();

// Public Routes (Guest checkout allowed, but populate user if logged in)
router.post('/', optionalAuth, createOrder);

// Protect subsequent routes
router.use(protect);

router.get('/my-orders', getMyOrders);

// Admin-Only Routes
router.get('/', restrictTo('admin'), getAllOrders);
router.patch('/:id/status', restrictTo('admin'), updateOrderStatus);

export default router;
