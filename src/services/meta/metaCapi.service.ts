/**
 * Meta Pixel + Conversions API configuration and sender.
 *
 * Off unless META_TRACKING_ENABLED=true AND META_PIXEL_ID is set. CAPI additionally needs
 * META_CAPI_ACCESS_TOKEN; without it only the browser Pixel runs. The access token stays on the
 * server: it is sent in the request body to graph.facebook.com and is never logged or returned.
 *
 *   META_TRACKING_ENABLED=true
 *   META_PIXEL_ID=1234567890
 *   META_CAPI_ACCESS_TOKEN=EAAB...            (server only)
 *   META_TEST_EVENT_CODE=TEST12345            (optional: events show in Events Manager → Test events)
 *   META_GRAPH_API_VERSION=v23.0              (optional)
 *   META_SITE_URL=https://solatidebiosciences.com.au  (optional; default: first non-hub CORS_ORIGIN)
 */
import axios from 'axios';
import config from '../../config';
import type { MetaServerEvent } from '../../domain/metaCapi';

const DEFAULT_GRAPH_VERSION = 'v23.0';
const CAPI_TIMEOUT_MS = 10_000;

export interface MetaConfig {
  enabled: boolean;
  pixelId: string;
  capiEnabled: boolean;
  testEventCode?: string;
}

export function getMetaConfig(): MetaConfig {
  const pixelId = (process.env.META_PIXEL_ID || '').trim();
  const enabled = process.env.META_TRACKING_ENABLED === 'true' && /^\d{5,20}$/.test(pixelId);
  return {
    enabled,
    pixelId: enabled ? pixelId : '',
    capiEnabled: enabled && !!(process.env.META_CAPI_ACCESS_TOKEN || '').trim(),
    testEventCode: (process.env.META_TEST_EVENT_CODE || '').trim() || undefined,
  };
}

/** Public storefront origin (Purchase event_source_url). */
export function metaSiteUrl(): string {
  if (process.env.META_SITE_URL) return process.env.META_SITE_URL.replace(/\/$/, '');
  const origins = Array.isArray(config.corsOrigin) ? config.corsOrigin : [config.corsOrigin];
  return (origins.find((o) => o && !/\/\/hub\./.test(o)) || 'https://solatidebiosciences.com.au').replace(/\/$/, '');
}

/** Origins the browser relay accepts as event_source_url. */
export function metaAllowedOrigins(): string[] {
  const origins = Array.isArray(config.corsOrigin) ? config.corsOrigin : [config.corsOrigin];
  return [...new Set([metaSiteUrl(), ...origins].filter(Boolean).map((o) => o.replace(/\/$/, '')))];
}

/** Errors worth retrying (rate limit, Meta-side trouble, network). */
export class MetaCapiError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

/**
 * POST events to the Conversions API. Resolves with Meta's events_received; throws MetaCapiError
 * (retryable for 429/5xx/network) so queue jobs and order steps are retried. No-op when disabled.
 */
export async function sendMetaEvents(events: MetaServerEvent[]): Promise<{ sent: number; skipped?: string }> {
  const cfg = getMetaConfig();
  if (!cfg.capiEnabled) return { sent: 0, skipped: 'disabled' };
  if (!events.length) return { sent: 0 };
  const base = (process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/$/, '');
  const version = (process.env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION).trim();
  const url = `${base}/${version}/${cfg.pixelId}/events`;
  try {
    const res = await axios.post(
      url,
      { data: events, access_token: process.env.META_CAPI_ACCESS_TOKEN, ...(cfg.testEventCode ? { test_event_code: cfg.testEventCode } : {}) },
      { timeout: CAPI_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
    );
    return { sent: Number(res.data?.events_received ?? events.length) };
  } catch (err: any) {
    const status: number | undefined = err?.response?.status;
    // Meta's error message (never the request, which holds the token)
    const detail = err?.response?.data?.error?.message || err?.code || err?.message || 'unknown error';
    const retryable = !status || status === 429 || status >= 500;
    throw new MetaCapiError(`Meta CAPI ${status ?? 'network'}: ${String(detail).slice(0, 300)}`, retryable);
  }
}

/** Purchase for a paid order (called once from the paid-order side effects; event_id dedups). */
export async function sendMetaPurchaseForOrder(order: any): Promise<{ sent: number; skipped?: string }> {
  if (!getMetaConfig().capiEnabled) return { sent: 0, skipped: 'disabled' };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildPurchaseEvent } = require('../../domain/metaCapi');
  const event = buildPurchaseEvent(order, { siteUrl: metaSiteUrl() });
  if (!event) return { sent: 0, skipped: 'too old or no value' };
  const res = await sendMetaEvents([event]);
  console.log(`[Meta CAPI] Purchase sent for order ${order.orderNumber || order._id} (${res.sent} received)`);
  return res;
}
