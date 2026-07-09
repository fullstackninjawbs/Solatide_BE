import express from 'express';
import * as discountController from '../../controllers/admin/discountController';

const router = express.Router();

router.get('/', discountController.getDiscounts);
router.get('/:id', discountController.getDiscountById);
router.post('/', discountController.createDiscount);
router.put('/:id', discountController.updateDiscount);
router.delete('/:id', discountController.deleteDiscount);
export default router;
