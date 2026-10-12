import express from 'express';
import * as discountController from '../../controllers/admin/discountController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect + restrictTo(ACCESS.discounts) applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.discounts));

router.post('/sync-from-tagada', discountController.syncFromTagada);
router.get('/', discountController.getDiscounts);
router.get('/:id', discountController.getDiscountById);
router.post('/', discountController.createDiscount);
router.put('/:id', discountController.updateDiscount);
router.delete('/:id', restrictTo(...ACCESS.discountDelete), discountController.deleteDiscount);
export default router;
