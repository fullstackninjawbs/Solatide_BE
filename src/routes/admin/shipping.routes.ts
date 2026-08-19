import express from 'express';
import * as shippingPackageController from '../../controllers/admin/shippingPackageController';

const router = express.Router();

// ── Shipping Packages ─────────────────────────────────────────────────────────
router.get('/packages', shippingPackageController.getPackages);
router.post('/packages', shippingPackageController.createPackage);
router.patch('/packages/:id', shippingPackageController.updatePackage);
router.delete('/packages/:id', shippingPackageController.deletePackage);
router.patch('/packages/:id/default', shippingPackageController.setDefaultPackage);

export default router;
