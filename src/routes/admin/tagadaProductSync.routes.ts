import express from 'express';
import {
  getSyncPreview,
  runFullSync,
  syncSingleProduct,
  getSyncHistory
} from '../../controllers/admin/tagadaProductSync.controller';

const router = express.Router();

// Apply auth and permission checks if needed
// e.g. router.use(restrictTo('admin', 'superadmin'));

router.get('/products/sync-preview', getSyncPreview);
router.post('/products/sync', runFullSync);
router.get('/products/sync-history', getSyncHistory);
router.post('/products/:tagadaProductId/sync', syncSingleProduct);

export default router;
