import express from 'express';
import * as customerController from '../../controllers/admin/customerController';

const router = express.Router();

router.get('/', customerController.getPlaceholder);

export default router;
