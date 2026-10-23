import { Router } from 'express';
import { getCheckoutConfig, submitOrderRequest } from '../controllers/orderRequest.controller';
import { checkoutLimiter, publicLimiter } from '../middleware/rateLimit';

const router = Router();

router.get('/config', publicLimiter, getCheckoutConfig);
router.post('/order-request', checkoutLimiter, submitOrderRequest);

export default router;
