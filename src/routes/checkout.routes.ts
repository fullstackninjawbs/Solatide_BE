import { Router } from 'express';
import { getCheckoutConfig, placeBankOrder, getBankOrder } from '../controllers/checkout.controller';
import { checkoutLimiter, publicLimiter } from '../middleware/rateLimit';

const router = Router();

router.get('/config', publicLimiter, getCheckoutConfig);
router.post('/bank-order', checkoutLimiter, placeBankOrder);
router.get('/bank-order/:id', publicLimiter, getBankOrder);

export default router;
