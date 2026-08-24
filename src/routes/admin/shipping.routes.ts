import express from 'express';
import * as shippingPackageController from '../../controllers/admin/shippingPackageController';
import { restrictTo } from '../../middleware/auth';

const router = express.Router();

// ── Shipping Packages ─────────────────────────────────────────────────────────
router.get('/packages', shippingPackageController.getPackages);
router.post('/packages', shippingPackageController.createPackage);
router.patch('/packages/:id', shippingPackageController.updatePackage);
router.delete('/packages/:id', restrictTo('super_admin'), shippingPackageController.deletePackage);
router.patch('/packages/:id/default', shippingPackageController.setDefaultPackage);

export default router;
