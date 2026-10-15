import { Router } from 'express';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';
import * as productController from '../../controllers/admin/productController';

const router = Router();

// All admin product routes require authentication
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.products));

router.route('/')
  .get(productController.getAllProducts)
  .post(restrictTo('admin', 'super_admin', 'operations'), productController.createProduct);

router.route('/:id')
  .get(productController.getProductById)
  .patch(restrictTo('admin', 'super_admin', 'operations'), productController.updateProduct)
  .delete(restrictTo('super_admin'), productController.deleteProduct);

router.patch('/:productId/media/:mediaId/alt-text', restrictTo('admin', 'super_admin', 'operations'), productController.updateMediaAltText);

export default router;
