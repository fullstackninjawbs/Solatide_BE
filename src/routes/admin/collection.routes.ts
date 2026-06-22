import express from 'express';
import * as collectionController from '../../controllers/admin/collectionController';

const router = express.Router();

router.get('/', collectionController.getPlaceholder);

export default router;
