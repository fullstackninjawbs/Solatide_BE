import express from 'express';
import * as productController from '../../controllers/admin/productController';

const router = express.Router();

router.get('/', productController.getPlaceholder);

export default router;
