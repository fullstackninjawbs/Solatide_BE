import { Request, Response } from 'express';
import { buildRelayedEvent } from '../domain/metaCapi';
import { getMetaConfig, metaAllowedOrigins } from '../services/meta/metaCapi.service';
import { isBotUserAgent } from './analytics.controller';

/**
 * GET /api/meta/config — what the storefront Pixel needs (the Pixel ID is public by design).
 * Short browser cache so enabling/disabling takes effect within minutes.
 */
export const getMetaPixelConfig = (_req: Request, res: Response): void => {
  const cfg = getMetaConfig();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ enabled: cfg.enabled, pixelId: cfg.pixelId || null });
};

/**
 * POST /api/meta/events — browser Pixel event relayed to the Conversions API with the same
 * event_id (Meta deduplicates the pair). Always answers 204 at once; never blocks the page.
 * Invalid events get 400 (for debugging); bots and disabled tracking are silently dropped.
 */
export const relayMetaEvent = (req: Request, res: Response): void => {
  const cfg = getMetaConfig();
  if (!cfg.capiEnabled || isBotUserAgent(req.headers['user-agent'])) {
    res.status(204).end();
    return;
  }
  const result = buildRelayedEvent(req.body, {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    allowedOrigins: metaAllowedOrigins(),
  });
  if (!result.ok) {
    res.status(400).json({ success: false, message: result.reason });
    return;
  }
  res.status(204).end();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../queues/producers').enqueueMetaEvent(result.event);
};
