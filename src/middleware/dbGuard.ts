import { Request, Response, NextFunction } from 'express';
import { isDbConnected, waitForDb } from '../config/db';

// Long enough to cover a worker's own startup connect during `pm2 reload`; short enough that
// visitors get a clear answer during an outage instead of a 10–30 s hang.
const WAIT_MS = 3000;

/**
 * While MongoDB is unavailable, answer 503 (with Retry-After) instead of letting every query
 * time out into a 500. Webhook senders (Tagada, Starshipit) retry non-2xx deliveries, so nothing is lost.
 */
export const dbGuard = async (req: Request, res: Response, next: NextFunction) => {
  if (isDbConnected() || (await waitForDb(WAIT_MS))) return next();
  res.set('Retry-After', '30');
  res.status(503).json({
    success: false,
    status: 'error',
    message: 'Service temporarily unavailable. Please try again shortly.',
  });
};

export default dbGuard;
