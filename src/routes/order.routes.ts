import { Router } from 'express';
import {
  createOrder,
  getMyOrders,
  getAllOrders,
  updateOrderStatus,
  getOrderById,
  handleStarshipitWebhook,
  verifyStarshipitWebhook,
} from '../controllers/order.controller';
import { protect, restrictTo, optionalAuth } from '../middleware/auth';
import { ACCESS } from '../config/roles';

const router = Router();

// Starshipit Webhook — shared-secret authenticated (STARSHIPIT_WEBHOOK_SECRET)
router.post('/webhook/starshipit', verifyStarshipitWebhook, handleStarshipitWebhook);

// Public Routes (Guest checkout allowed, but populate user if logged in)
router.post('/', optionalAuth, createOrder);

// Authenticated customer order history — must be registered before '/:id'
router.get('/my-orders', protect, getMyOrders);

// Admin-Only Routes
router.get('/', protect, restrictTo(...ACCESS.orderPrivileged), getAllOrders);
router.patch('/:id/status', protect, restrictTo(...ACCESS.orderPrivileged), updateOrderStatus);

// Order lookup: owner / staff via JWT, or guest via ?accessToken=<order.publicAccessToken>
router.get('/:id', optionalAuth, getOrderById);

export default router;
