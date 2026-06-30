import { Router } from 'express';
import { protect, restrictTo } from '../../middleware/auth';
import * as batchController from '../../controllers/batch.controller';

const router = Router();

// Protect all routes and restrict to admin
router.use(protect);
router.use(restrictTo('admin', 'super_admin'));

router.route('/')
  .get(batchController.getBatches)
  .post(batchController.createBatch);

router.route('/:id')
  .get(batchController.getBatchById)
  .put(batchController.updateBatch)
  .delete(batchController.deleteBatch);

export default router;
