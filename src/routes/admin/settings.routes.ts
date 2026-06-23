import express from 'express';
import * as settingsController from '../../controllers/admin/settingsController';
import { testTagadaConnection } from '../../controllers/payment.controller';

const router = express.Router();

// Legacy placeholder
router.get('/', settingsController.getPlaceholder);

// ── TagadaPay Settings ────────────────────────────────────────────────────────
router.get('/tagada', settingsController.getTagadaSettings);
router.put('/tagada', settingsController.updateTagadaSettings);

// Test Tagada connection (makes a live API call to verify credentials)
router.get('/tagada/test', testTagadaConnection);

export default router;
