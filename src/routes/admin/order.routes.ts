import express from 'express';
import { protect } from '../../middleware/auth';
import { getOrders, getOrderById, updateOrderStatus } from '../../controllers/admin/orderController';

const router = express.Router();

// All routes require authentication
router.use(protect);

// GET  /api/admin/orders               — paginated, filterable list
router.get('/', getOrders);

// GET  /api/admin/orders/:id           — full order detail
router.get('/:id', getOrderById);

// PATCH /api/admin/orders/:id/status   — update status / fulfilmentStatus / adminNotes
router.patch('/:id/status', updateOrderStatus);

export default router;
