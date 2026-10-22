import type { SendMailOptions } from 'nodemailer';
import { queuesEnabled, getProducerConnection } from './connection';
import { getQueue, QUEUE_NAMES } from './queues';

/**
 * Producers: add a background job when queues are available, otherwise fall back to the
 * previous in-process behaviour (so a Redis outage never loses an order follow-up or an email).
 */

/** Wait (briefly) for the fail-fast producer connection to be ready. */
async function producerReadyWithin(ms: number): Promise<boolean> {
  const conn = getProducerConnection();
  if (conn.status === 'ready') return true;
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(t); conn.off('ready', onReady); resolve(ok); };
    const onReady = () => done(true);
    const t = setTimeout(() => done(conn.status === 'ready'), ms);
    conn.once('ready', onReady);
  });
}

async function tryAdd(queueName: (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES], jobName: string, data: unknown, opts: Record<string, unknown> = {}): Promise<boolean> {
  if (!queuesEnabled()) return false;
  try {
    if (!(await producerReadyWithin(2000))) return false;
    await getQueue(queueName).add(jobName, data, opts);
    return true;
  } catch (err: any) {
    console.warn(`[Queue] could not add ${queueName}/${jobName} (falling back in-process): ${err?.message}`);
    return false;
  }
}

/**
 * Post-payment side effects for an order. Deduplicated per order (jobId); retried with
 * backoff, and each retry only re-runs the steps that failed.
 */
export function enqueueOrderPaid(orderId: unknown): void {
  const id = String(orderId);
  tryAdd(QUEUE_NAMES.orders, 'order-paid', { orderId: id }, { jobId: `order-paid-${id}` })
    .then((queued) => {
      if (queued) return;
      // Fallback: previous behaviour (in-process, right after the response)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { onOrderPaid } = require('../services/orders/onOrderPaid');
      setImmediate(() => {
        onOrderPaid(id).catch((err: any) => console.error(`[onOrderPaid] order=${id} unexpected failure:`, err?.message ?? err));
      });
    })
    .catch(() => undefined);
}

/**
 * Browser Pixel event → Conversions API. Deduplicated per event (jobId), retried briefly; without
 * queues it is sent once in-process (best effort). Never throws into the request.
 */
export function enqueueMetaEvent(event: { event_name: string; event_id: string }): void {
  tryAdd(QUEUE_NAMES.meta, 'event', { event }, { jobId: `meta-${event.event_name}-${event.event_id}` })
    .then((queued) => {
      if (queued) return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sendMetaEvents } = require('../services/meta/metaCapi.service');
      sendMetaEvents([event]).catch((err: any) => console.warn(`[Meta CAPI] ${event.event_name} not sent: ${err?.message}`));
    })
    .catch(() => undefined);
}

/**
 * Send an email: queued (retried on SMTP failure) when queues are available, otherwise sent
 * directly as before. Mail options must be JSON-serialisable (no attachments/streams).
 * Returns the nodemailer info when sent directly, or { queued: true }.
 */
export async function deliverMail(mail: SendMailOptions): Promise<{ queued: true } | any> {
  if (await tryAdd(QUEUE_NAMES.email, 'send', { mail })) return { queued: true };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { transporter } = require('../config/email');
  return transporter.sendMail(mail);
}

/**
 * Request a storefront rebuild. Debounced: requests within 10 s collapse into one job; while a
 * build runs, new requests create (at most) one follow-up build. Returns false when queues are
 * unavailable so the caller can use the file-lock fallback.
 */
export async function enqueueStorefrontRebuild(): Promise<boolean> {
  return tryAdd(QUEUE_NAMES.rebuild, 'rebuild', { requestedAt: new Date().toISOString() }, {
    delay: 10_000,
    deduplication: { id: 'storefront-rebuild', ttl: 10_000, extend: true, replace: true },
  });
}
