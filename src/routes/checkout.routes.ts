import { Router } from 'express';
import { getCheckoutConfig, placeBankOrder, getBankOrder, previewDiscount } from '../controllers/checkout.controller';
import { submitOrderRequest } from '../controllers/orderRequest.controller';
import { checkoutLimiter, discountCheckLimiter, publicLimiter } from '../middleware/rateLimit';

const router = Router();

// Which checkout is active (Admin → Settings → Checkout mode) + what it needs
router.get('/config', publicLimiter, getCheckoutConfig);
// "Apply" a discount code (both checkouts)
router.post('/discount', discountCheckLimiter, previewDiscount);
// Order Request mode
router.post('/order-request', checkoutLimiter, submitOrderRequest);
// Manual Bank Transfer / PayID mode
router.post('/bank-order', checkoutLimiter, placeBankOrder);
router.get('/bank-order/:id', publicLimiter, getBankOrder);

export default router;
