import express from 'express';
import * as coaController from '../../controllers/admin/coaController';

const router = express.Router();

router.get('/', coaController.getPlaceholder);

export default router;
