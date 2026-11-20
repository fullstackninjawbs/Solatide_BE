import express from 'express';
import * as analyticsController from '../../controllers/admin/analyticsController';
import * as liveController from '../../controllers/admin/liveAnalyticsController';
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

// Live customer activity (dashboard)
router.get('/live/visitors', liveController.getLiveVisitors);
router.get('/live/visitors/:sessionId', liveController.getLiveVisitor);
router.get('/live/visitors/:sessionId/profile', liveController.getVisitorProfile);
router.get('/live/activity', liveController.getLiveActivity);
router.get('/live/stream', liveController.streamLive);

export default router;
