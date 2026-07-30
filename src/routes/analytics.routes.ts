import { Router } from 'express';
import { logEvent } from '../controllers/analytics.controller';

const router = Router();

// Public — no auth required. Storefront fires events here.
router.post('/events', logEvent);

export default router;
