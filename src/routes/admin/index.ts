import express from 'express';
import { protect, restrictTo } from '../../middleware/auth';
import { ACCESS, STAFF_ROLES } from '../../config/roles';
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
import tagadaProductSyncRoutes from './tagadaProductSync.routes';
import shippingRoutes from './shipping.routes';
import { getQueueStats, retryFailedJobs } from '../../queues/stats';

const router = express.Router();

/**
 * SECURITY: every /api/admin/* route requires a valid JWT and a staff role.
 * There are intentionally NO public admin routes (admin login lives at
 * /api/v1/auth/login). Per-area role restrictions are applied below and inside
 * each sub-router. Role lists live in src/config/roles.ts.
 */
router.use(protect);
router.use(restrictTo(...STAFF_ROLES));

router.use('/auth', authRoutes);
router.use('/dashboard', restrictTo(...ACCESS.dashboard), dashboardRoutes);
router.use('/product', restrictTo(...ACCESS.products), productRoutes);
router.use('/batches', restrictTo(...ACCESS.batches), batchRoutes);
router.use('/collection', restrictTo(...ACCESS.collections), collectionRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/coa', coaRoutes);
router.use('/order', restrictTo(...ACCESS.orders), orderRoutes);
router.use('/customer', restrictTo(...ACCESS.customers), customerRoutes);
router.use('/discount', restrictTo(...ACCESS.discounts), discountRoutes);
router.use('/content', restrictTo(...ACCESS.content), contentRoutes);
router.use('/growth', growthRoutes); // per-route restrictions inside
router.use('/analytics', restrictTo(...ACCESS.analytics), analyticsRoutes);
router.use('/settings', restrictTo(...ACCESS.settingsRead), settingsRoutes); // narrower per-route inside
router.use('/users', restrictTo(...ACCESS.adminUsers), userRoutes);
router.use('/tagada', restrictTo(...ACCESS.tagadaSync), tagadaProductSyncRoutes);
router.use('/shipping', restrictTo(...ACCESS.shippingPackages), shippingRoutes);
// Background job queues: counts, recent failures, schedules; retry failed jobs (never deletes)
router.get('/queues', restrictTo('super_admin', 'admin'), getQueueStats);
router.post('/queues/:name/retry-failed', restrictTo('super_admin', 'admin'), retryFailedJobs);

export default router;
