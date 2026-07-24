import express from 'express';
import { protect } from '../../middleware/auth';
import { getOrders, getOrderById, updateOrderStatus, updateOrder, createShipment, refundOrder, getOrderRefunds } from '../../controllers/admin/orderController';

const router = express.Router();

// All routes require authentication
router.use(protect);

// GET  /api/admin/orders               — paginated, filterable list
router.get('/', getOrders);

// GET  /api/admin/orders/:id           — full order detail
router.get('/:id', getOrderById);

// PATCH /api/admin/orders/:id          — update full order details
router.patch('/:id', updateOrder);

// PATCH /api/admin/orders/:id/status   — update status / fulfilmentStatus / adminNotes
router.patch('/:id/status', updateOrderStatus);

// POST /api/admin/orders/:id/refund      — process refund
router.post('/:id/refund', refundOrder);

// GET /api/admin/orders/:id/refunds      — list refunds
router.get('/:id/refunds', getOrderRefunds);

// POST /api/admin/orders/:id/shipment — create shipment
router.post('/:id/shipment', createShipment);

export default router;
