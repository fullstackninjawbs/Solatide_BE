import express from 'express';
import * as collectionController from '../../controllers/admin/collectionController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();

// Protect all routes and restrict to permitted admin roles
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.collections));

router.route('/')
  .get(collectionController.getCollections)
  .post(collectionController.createCollection);

router.route('/:id')
  .get(collectionController.getCollectionById)
  .patch(collectionController.updateCollection)
  .delete(restrictTo('super_admin'), collectionController.deleteCollection);

export default router;
