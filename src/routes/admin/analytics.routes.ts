import express from 'express';
import * as analyticsController from '../../controllers/admin/analyticsController';

const router = express.Router();

router.get('/', analyticsController.getPlaceholder);

export default router;
