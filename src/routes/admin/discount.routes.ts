import express from 'express';
import * as discountController from '../../controllers/admin/discountController';

const router = express.Router();

router.get('/', discountController.getPlaceholder);

export default router;
