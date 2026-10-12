import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';

const router = Router();

/**
 * GET /api/health
 * Minimal public health status for monitors / load balancers.
 * Deliberately exposes no environment, version, memory or database-name details.
 */
router.get('/', (req: Request, res: Response) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? 'healthy' : 'degraded',
    db: connected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

export default router;
