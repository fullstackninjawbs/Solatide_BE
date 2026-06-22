import express from 'express';
import * as inventoryController from '../../controllers/admin/inventoryController';

const router = express.Router();

router.get('/', inventoryController.getPlaceholder);

export default router;
