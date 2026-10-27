import express from 'express';
import * as customerController from '../../controllers/admin/customerController';
import { restrictTo } from '../../middleware/auth';
import { ACCESS } from '../../config/roles';

const router = express.Router();
// protect applied in routes/admin/index.ts
router.use(restrictTo(...ACCESS.customers));

router.get('/', customerController.getCustomers);
// Before '/:id' so "export" is not read as a customer id
router.get('/export/csv', customerController.exportCustomersCsv);
router.get('/:id', customerController.getCustomerById);
router.put('/:id', customerController.updateCustomer);

export default router;
