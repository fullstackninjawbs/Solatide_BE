import express from 'express';
import * as dashboardController from '../../controllers/admin/dashboardController';

const router = express.Router();

router.get('/', dashboardController.getDashboardAnalytics);

export default router;
