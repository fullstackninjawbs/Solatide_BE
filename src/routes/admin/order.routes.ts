import express from 'express';
import { protect } from '../../middleware/auth';
import {
  getOrders,
  getOrderById,
  updateOrderStatus,
  updateOrder,
  createShipment,
  refundOrder,
  getOrderRefunds,
  createAdminOrder,
  getNewOrderConfig,
  revalidateOrderAddress,
  exportOrdersCsv
} from '../../controllers/admin/orderController';

const router = express.Router();

// All routes require authentication
router.use(protect);

// GET  /api/admin/orders               — paginated, filterable list
router.get('/', getOrders);

// GET  /api/admin/orders/export/csv    — export orders to CSV
router.get('/export/csv', exportOrdersCsv);

// GET  /api/admin/orders/new-config     — form config options
router.get('/new-config', getNewOrderConfig);

// POST /api/admin/orders               — create manual order
router.post('/', createAdminOrder);

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

// POST /api/admin/orders/:id/revalidate-address — force re-run address validation
router.post('/:id/revalidate-address', revalidateOrderAddress);

export default router;
