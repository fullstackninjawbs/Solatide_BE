import express from 'express';
import * as shippingPackageController from '../../controllers/admin/shippingPackageController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.shippingPackages));

// ── Shipping Packages ─────────────────────────────────────────────────────────
router.get('/packages', shippingPackageController.getPackages);
router.post('/packages', shippingPackageController.createPackage);
router.patch('/packages/:id', shippingPackageController.updatePackage);
router.delete('/packages/:id', restrictTo(...ACCESS.shippingPackageDelete), shippingPackageController.deletePackage);
router.patch('/packages/:id/default', shippingPackageController.setDefaultPackage);

export default router;
