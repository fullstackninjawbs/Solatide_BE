import express from 'express';
import * as customerController from '../../controllers/admin/customerController';

const router = express.Router();

router.get('/', customerController.getCustomers);
router.get('/:id', customerController.getCustomerById);
router.put('/:id', customerController.updateCustomer);

export default router;
