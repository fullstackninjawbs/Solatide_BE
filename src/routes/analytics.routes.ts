import express, { Router } from 'express';
import { logEvent, collect } from '../controllers/analytics.controller';

const router = Router();

// Public — no auth required. Storefront fires events here.
// Rate limited (analyticsLimiter) and body-capped (100kb) in app.ts.
// The storefront sends text/plain (JSON inside) so sendBeacon needs no CORS preflight and events
// sent while a page closes are not dropped; application/json is accepted too.
// helmet's default Cross-Origin-Resource-Policy (same-origin) makes the browser block the reply to a
// cross-origin beacon (storefront on another origin, e.g. localhost:5173 → :5000) with a console
// error. The reply is only { success } and carries no data, so it may be read cross-origin.
const allowCrossOriginReply: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
};
router.post('/collect', allowCrossOriginReply, express.text({ type: 'text/plain', limit: '100kb' }), collect);
// Previous endpoint (single events), kept for pages loaded before the tracking update
router.post('/events', logEvent);

export default router;
