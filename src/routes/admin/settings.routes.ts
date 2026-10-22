import express from 'express';
import * as settingsController from '../../controllers/admin/settingsController';
import { testTagadaConnection } from '../../controllers/payment.controller';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect + staff check applied in routes/admin/index.ts

// ── Store Settings ────────────────────────────────────────────────────────────
router.get('/store', restrictTo(...ACCESS.settingsRead), settingsController.getStoreSettings);
router.put('/store', restrictTo(...ACCESS.settingsStoreWrite), settingsController.updateStoreSettings);

// ── Bank transfer / PayID checkout ───────────────────────────────────────────
router.get('/bank-transfer', restrictTo(...ACCESS.settingsRead), settingsController.getBankTransferSettings);
router.put('/bank-transfer', restrictTo(...ACCESS.settingsPayment), settingsController.updateBankTransferSettings);

// ── TagadaPay Settings ────────────────────────────────────────────────────────
router.get('/tagada', restrictTo(...ACCESS.settingsRead), settingsController.getTagadaSettings);
// Payment credentials + webhook secret: super_admin only
router.put('/tagada', restrictTo(...ACCESS.settingsPayment), settingsController.updateTagadaSettings);

// Test Tagada connection (makes a live API call to verify credentials)
router.get('/tagada/test', restrictTo(...ACCESS.settingsPayment), testTagadaConnection);

export default router;
