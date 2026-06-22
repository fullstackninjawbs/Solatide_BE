import express from 'express';
import authRoutes from './auth.routes.ts';
import dashboardRoutes from './dashboard.routes.ts';
import productRoutes from './product.routes.ts';
import collectionRoutes from './collection.routes.ts';
import inventoryRoutes from './inventory.routes.ts';
import coaRoutes from './coa.routes.ts';
import orderRoutes from './order.routes.ts';
import customerRoutes from './customer.routes.ts';
import discountRoutes from './discount.routes.ts';
import contentRoutes from './content.routes.ts';
import growthRoutes from './growth.routes.ts';
import analyticsRoutes from './analytics.routes.ts';
import settingsRoutes from './settings.routes.ts';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/product', productRoutes);
router.use('/collection', collectionRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/coa', coaRoutes);
router.use('/order', orderRoutes);
router.use('/customer', customerRoutes);
router.use('/discount', discountRoutes);
router.use('/content', contentRoutes);
router.use('/growth', growthRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/settings', settingsRoutes);

export default router;
