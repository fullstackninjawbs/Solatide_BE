import { Router } from 'express';
import { logEvent } from '../controllers/analytics.controller';

const router = Router();

// Public — no auth required. Storefront fires events here.
// Rate limited (analyticsLimiter) and body-capped (100kb) in app.ts.
router.post('/events', logEvent);

export default router;
