import express from 'express';
import {
  getSyncPreview,
  runFullSync,
  syncSingleProduct,
  getSyncHistory
} from '../../controllers/admin/tagadaProductSync.controller';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.tagadaSync));

router.get('/products/sync-preview', getSyncPreview);
router.post('/products/sync', runFullSync);
router.get('/products/sync-history', getSyncHistory);
router.post('/products/:tagadaProductId/sync', syncSingleProduct);

export default router;
