import express from 'express';
import * as orderController from '../../controllers/admin/orderController';

const router = express.Router();

router.get('/', orderController.getPlaceholder);

export default router;
