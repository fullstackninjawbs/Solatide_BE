import { Router } from 'express';
import authRoutes from './auth.routes';
import productRoutes from './product.routes';
import orderRoutes from './order.routes';
import reviewRoutes from './review.routes';
import contentRoutes from './content.routes';

const router = Router();

// Versioned registries
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/orders', orderRoutes);
router.use('/reviews', reviewRoutes);
router.use('/content', contentRoutes);

export default router;
