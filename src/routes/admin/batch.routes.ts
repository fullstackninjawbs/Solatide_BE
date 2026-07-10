import { Router } from 'express';
import { protect, restrictTo } from '../../middleware/auth';
import * as batchController from '../../controllers/batch.controller';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for PDFs
});

const router = Router();

// Public routes
router.get('/proxy-coa', batchController.proxyCoa);

// Protect all routes and restrict to admin
router.use(protect);
router.use(restrictTo('admin', 'super_admin'));

router.route('/')
  .get(batchController.getBatches)
  .post(batchController.createBatch);

router.post('/upload-coa', upload.single('coaFile'), batchController.uploadCOA);

router.route('/:id')
  .get(batchController.getBatchById)
  .put(batchController.updateBatch)
  .delete(batchController.deleteBatch);

export default router;
