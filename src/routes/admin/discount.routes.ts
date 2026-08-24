import express from 'express';
import * as discountController from '../../controllers/admin/discountController';
import { restrictTo } from '../../middleware/auth';

const router = express.Router();

router.post('/sync-from-tagada', discountController.syncFromTagada);
router.get('/', discountController.getDiscounts);
router.get('/:id', discountController.getDiscountById);
router.post('/', discountController.createDiscount);
router.put('/:id', discountController.updateDiscount);
router.delete('/:id', restrictTo('super_admin'), discountController.deleteDiscount);
export default router;
