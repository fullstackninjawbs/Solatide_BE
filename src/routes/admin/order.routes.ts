import express, { Response, NextFunction } from 'express';
import { restrictTo, AuthenticatedRequest } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';
import AppError from '../../utils/appError';
import {
  getOrders,
  getOrderById,
  updateOrderStatus,
  sendOrderConfirmation,
  updateOrder,
  createShipment,
  refundOrder,
  getOrderRefunds,
  createAdminOrder,
  getNewOrderConfig,
  getOrderRequestForAdmin,
  revalidateOrderAddress,
  addressAutocomplete,
  addressPlaceDetails,
  exportOrdersCsv,
  softDeleteOrder,
  restoreOrder,
  bulkSoftDeleteOrders,
  bulkRestoreOrders
} from '../../controllers/admin/orderController';

const router = express.Router();

// protect is applied in routes/admin/index.ts; base access for every order route:
router.use(restrictTo(...ACCESS.orders));

const shipping = restrictTo(...ACCESS.orderShipping);
const privileged = restrictTo(...ACCESS.orderPrivileged);

/** Only privileged roles may change paymentStatus via the status endpoint. */
const guardPaymentStatusEdit = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (req.body && req.body.paymentStatus !== undefined && !ACCESS.orderPrivileged.includes(req.user!.role)) {
    return next(new AppError('You do not have permission to change payment status', 403));
  }
  next();
};

// GET  /api/admin/order               — paginated, filterable list
router.get('/', getOrders);

// GET  /api/admin/order/export/csv    — export orders to CSV
router.get('/export/csv', exportOrdersCsv);

// Address helpers + config — used by the manual order form
router.get('/address/autocomplete', privileged, addressAutocomplete);
router.get('/address/place-details', privileged, addressPlaceDetails);
router.get('/new-config', privileged, getNewOrderConfig);

// Storefront order request → pre-fill Create order (before '/:id')
router.get('/requests/:id', privileged, getOrderRequestForAdmin);

// POST /api/admin/order               — create manual order
router.post('/', privileged, createAdminOrder);

// GET  /api/admin/order/:id           — full order detail
router.get('/:id', getOrderById);

// Bulk soft delete / restore
router.post('/bulk-soft-delete', privileged, bulkSoftDeleteOrders);
router.post('/bulk-restore', privileged, bulkRestoreOrders);

// Single soft delete / restore
router.delete('/:id/soft-delete', privileged, softDeleteOrder);
router.patch('/:id/restore', privileged, restoreOrder);

// PATCH /api/admin/order/:id          — tags, comments, addresses, admin notes
router.patch('/:id', updateOrder);

// PATCH /api/admin/order/:id/status   — status / fulfilmentStatus / adminNotes (+ paymentStatus for privileged)
router.patch('/:id/status', guardPaymentStatusEdit, updateOrderStatus);

// POST /api/admin/order/:id/send-confirmation — email the customer their order confirmation (paid orders)
router.post('/:id/send-confirmation', privileged, sendOrderConfirmation);

// Refunds
router.post('/:id/refund', restrictTo(...ACCESS.orderRefund), refundOrder);
router.get('/:id/refunds', getOrderRefunds);

// Shipping labels
router.post('/:id/shipment', shipping, createShipment);
router.post('/:id/revalidate-address', shipping, revalidateOrderAddress);

export default router;
