import { Router } from 'express';
import {
  createOrder,
  getMyOrders,
  getAllOrders,
  updateOrderStatus,
  getOrderById,
  handleStarshipitWebhook,
} from '../controllers/order.controller';
import { protect, restrictTo, optionalAuth } from '../middleware/auth';

const router = Router();

// Public Routes (Guest checkout allowed, but populate user if logged in)
router.post('/', optionalAuth, createOrder);

// Public order lookup (used by checkout success/failure pages)
router.get('/:id', optionalAuth, getOrderById);

// Starshipit Webhook
router.post('/webhook/starshipit', handleStarshipitWebhook);

// Protect subsequent routes
router.use(protect);

router.get('/my-orders', getMyOrders);

// Admin-Only Routes
router.get('/', restrictTo('admin'), getAllOrders);
router.patch('/:id/status', restrictTo('admin'), updateOrderStatus);

export default router;
