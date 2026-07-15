import express from 'express';
import authRoutes from './auth.routes';
import dashboardRoutes from './dashboard.routes';
import productRoutes from './product.routes';
import batchRoutes from './batch.routes';
import collectionRoutes from './collection.routes';
import inventoryRoutes from './inventory.routes';
import coaRoutes from './coa.routes';
import orderRoutes from './order.routes';
import customerRoutes from './customer.routes';
import discountRoutes from './discount.routes';
import contentRoutes from './content.routes';
import growthRoutes from './growth.routes';
import analyticsRoutes from './analytics.routes';
import settingsRoutes from './settings.routes';
import userRoutes from './user.routes';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/product', productRoutes);
router.use('/batches', batchRoutes);
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
router.use('/users', userRoutes);

export default router;
