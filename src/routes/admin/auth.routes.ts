import express from 'express';
import * as authController from '../../controllers/admin/authController';

const router = express.Router();

router.get('/', authController.getPlaceholder);

export default router;
