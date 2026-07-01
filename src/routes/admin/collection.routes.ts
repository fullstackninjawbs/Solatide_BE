import express from 'express';
import * as collectionController from '../../controllers/admin/collectionController';
import { protect, restrictTo } from '../../middleware/auth';

const router = express.Router();

// Protect all routes and restrict to permitted admin roles
router.use(protect);
router.use(restrictTo('admin', 'super_admin', 'content_manager', 'operations'));

router.route('/')
  .get(collectionController.getCollections)
  .post(collectionController.createCollection);

router.route('/:id')
  .get(collectionController.getCollectionById)
  .patch(collectionController.updateCollection)
  .delete(collectionController.deleteCollection);

export default router;
