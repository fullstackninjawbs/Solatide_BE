import express from 'express';
import * as analyticsController from '../../controllers/admin/analyticsController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.analytics));

router.get('/orders/summary', analyticsController.getSummary);
router.get('/orders/by-day', analyticsController.getOrdersByDay);
router.get('/orders/by-status', analyticsController.getOrdersByStatus);
router.get('/revenue/by-product', analyticsController.getRevenueByProduct);
router.get('/customers/top', analyticsController.getTopCustomers);
router.get('/overview', analyticsController.getOverview);
router.get('/attribution', analyticsController.getAttributionStats);

export default router;
