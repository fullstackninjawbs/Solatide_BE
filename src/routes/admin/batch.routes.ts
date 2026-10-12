import { Router } from 'express';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';
import { pdfOrImageFileFilter } from '../../middleware/uploadFilters';
import * as batchController from '../../controllers/batch.controller';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10MB limit for PDFs
  fileFilter: pdfOrImageFileFilter,
});

const router = Router();

// protect applied in routes/admin/index.ts (proxy-coa is no longer public —
// the Client does not use it). Restrict to batch roles:
router.use(restrictTo(...ACCESS.batches));

router.get('/proxy-coa', batchController.proxyCoa);

router.route('/')
  .get(batchController.getBatches)
  .post(batchController.createBatch);

router.post('/upload-coa', upload.single('coaFile'), batchController.uploadCOA);

router.route('/:id')
  .get(batchController.getBatchById)
  .put(batchController.updateBatch)
  .delete(restrictTo('super_admin'), batchController.deleteBatch);

export default router;
