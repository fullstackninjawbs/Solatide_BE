import { Router } from 'express';
import { protect, restrictTo } from '../../middleware/auth';
import * as productController from '../../controllers/admin/productController';

const router = Router();

// All admin product routes require authentication
router.use(protect);
router.use(restrictTo('admin', 'super_admin', 'operations', 'content_manager'));

router.route('/')
  .get(productController.getAllProducts)
  .post(restrictTo('admin', 'super_admin', 'operations'), productController.createProduct);

router.route('/:id')
  .get(productController.getProductById)
  .patch(restrictTo('admin', 'super_admin', 'operations'), productController.updateProduct)
  .delete(restrictTo('admin', 'super_admin'), productController.deleteProduct);

router.delete('/', restrictTo('admin', 'super_admin'), productController.deleteAllProducts);

export default router;
