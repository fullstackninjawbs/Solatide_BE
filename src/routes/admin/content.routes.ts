import express from 'express';
import * as contentController from '../../controllers/admin/contentController';

const router = express.Router();

router.get('/', contentController.getPlaceholder);

export default router;
