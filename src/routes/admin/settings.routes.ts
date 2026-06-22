import express from 'express';
import * as settingsController from '../../controllers/admin/settingsController';

const router = express.Router();

router.get('/', settingsController.getPlaceholder);

export default router;
