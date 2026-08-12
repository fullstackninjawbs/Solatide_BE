import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';

const router = Router();

/**
 * GET /health
 * Returns the current health status of the API.
 * Used by monitoring tools, load balancers, and deployment pipelines.
 * No authentication required.
 */
router.get('/', async (req: Request, res: Response) => {
  const startTime = process.hrtime();

  const memUsage = process.memoryUsage();
  const uptimeSeconds = Math.floor(process.uptime());

  // Check MongoDB connection state
  // 1 = connected, 0 = disconnected, 2 = connecting, 3 = disconnecting
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';

  const [s, ns] = process.hrtime(startTime);
  const responseTimeMs = (s * 1000 + ns / 1e6).toFixed(2);

  const status = dbState === 1 ? 'healthy' : 'degraded';

  res.status(dbState === 1 ? 200 : 503).json({
    status,
    uptime: uptimeSeconds,
    responseTimeMs: Number(responseTimeMs),
    db: {
      status: dbStatus,
      name: mongoose.connection.name || 'solatide',
    },
    memory: {
      usedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      totalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
    },
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

export default router;
