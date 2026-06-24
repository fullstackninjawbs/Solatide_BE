/**
 * payment.routes.ts
 * ─────────────────
 * Routes for TagadaPay payment flows.
 *
 * IMPORTANT — Webhook raw body:
 * The webhook route uses express.raw() to receive the raw body buffer
 * needed for HMAC-SHA256 signature verification. This must be registered
 * BEFORE the global express.json() middleware on this route, which is why
 * the webhook route is defined here with its own body parser.
 */

import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import {
  createTagadaPayment,
  tagadaWebhook,
} from '../controllers/payment.controller';
import { protect, optionalAuth } from '../middleware/auth';

const router = Router();

// ── POST /api/payments/tagada/create ──────────────────────────────────────────
// Public: guest or authenticated (populates user if logged in)
router.post('/tagada/create', optionalAuth, createTagadaPayment);

// ── POST /api/payments/tagada/webhook ─────────────────────────────────────────
// Public (no auth): Tagada calls this endpoint directly.
// Uses express.raw() to preserve the raw body for signature verification.
// The parsed raw buffer is attached to req.rawBody for use in the controller.
router.post(
  '/tagada/webhook',
  express.raw({ type: 'application/json' }),
  (req: Request, _res: Response, next: NextFunction) => {
    // Attach raw body to req so the controller can verify the HMAC signature
    (req as any).rawBody = req.body;
    next();
  },
  tagadaWebhook
);

export default router;
