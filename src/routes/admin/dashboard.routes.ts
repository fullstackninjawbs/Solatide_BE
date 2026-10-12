import express from 'express';
import * as dashboardController from '../../controllers/admin/dashboardController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.dashboard));

router.get('/', dashboardController.getDashboardAnalytics);

export default router;
