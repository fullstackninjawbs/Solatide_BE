import express, { Router } from 'express';
import { logEvent, collect } from '../controllers/analytics.controller';

const router = Router();

// Public — no auth required. Storefront fires events here.
// Rate limited (analyticsLimiter) and body-capped (100kb) in app.ts.
// The storefront sends text/plain (JSON inside) so sendBeacon needs no CORS preflight and events
// sent while a page closes are not dropped; application/json is accepted too.
router.post('/collect', express.text({ type: 'text/plain', limit: '100kb' }), collect);
// Previous endpoint (single events), kept for pages loaded before the tracking update
router.post('/events', logEvent);

export default router;
