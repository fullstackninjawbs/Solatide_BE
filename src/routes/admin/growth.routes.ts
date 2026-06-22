import express from 'express';
import * as growthController from '../../controllers/admin/growthController';

const router = express.Router();

router.get('/', growthController.getPlaceholder);

export default router;
