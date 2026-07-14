import express from 'express';
import * as analyticsController from '../../controllers/admin/analyticsController';

const router = express.Router();

router.get('/orders/summary', analyticsController.getSummary);
router.get('/orders/by-day', analyticsController.getOrdersByDay);
router.get('/orders/by-status', analyticsController.getOrdersByStatus);
router.get('/revenue/by-product', analyticsController.getRevenueByProduct);
router.get('/customers/top', analyticsController.getTopCustomers);

export default router;
