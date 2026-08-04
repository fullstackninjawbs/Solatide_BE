import { Router } from 'express';
import { register, login, getMe, forgotPassword, resetPassword } from '../controllers/auth.controller';
import { protect } from '../middleware/auth';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', protect, getMe);
router.post('/forgot-password', forgotPassword);
router.patch('/reset-password/:token', resetPassword);

export default router;
