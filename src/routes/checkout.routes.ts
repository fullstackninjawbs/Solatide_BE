import { Router } from 'express';
import { getCheckoutConfig, placeBankOrder, getBankOrder } from '../controllers/checkout.controller';
import { submitOrderRequest } from '../controllers/orderRequest.controller';
import { checkoutLimiter, publicLimiter } from '../middleware/rateLimit';

const router = Router();

// Which checkout is active (Admin → Settings → Checkout mode) + what it needs
router.get('/config', publicLimiter, getCheckoutConfig);
// Order Request mode
router.post('/order-request', checkoutLimiter, submitOrderRequest);
// Manual Bank Transfer / PayID mode
router.post('/bank-order', checkoutLimiter, placeBankOrder);
router.get('/bank-order/:id', publicLimiter, getBankOrder);

export default router;
