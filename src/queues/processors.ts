import { Job, Queue, UnrecoverableError } from 'bullmq';
import { onOrderPaid } from '../services/orders/onOrderPaid';
import { runDeploy, EXIT_BUSY } from '../utils/rebuildStorefront';
import {
  refreshStarshipitTracking,
  scheduledTagadaSync,
  runDatabaseBackup,
  sendAbandonedCheckoutReminders,
} from '../services/scheduled/scheduledJobs';

/** order-side-effects: claim (or resume) the order; fail the job if any step failed → retried. */
export async function processOrderPaid(job: Job<{ orderId: string }>) {
  const res = await onOrderPaid(job.data.orderId, undefined, { resume: true });
  if (res.claimed && res.errors.length) {
    throw new Error(`side-effect steps failed: ${res.errors.join(', ')}`);
  }
  return res.claimed ? { claimed: true, resumed: !!res.resumed } : { claimed: false };
}

/** meta-capi: send one browser-relayed event; 429/5xx/network errors are retried, others are not. */
export async function processMetaEvent(job: Job<{ event: any }>) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sendMetaEvents } = require('../services/meta/metaCapi.service');
  try {
    return await sendMetaEvents([job.data.event]);
  } catch (err: any) {
    if (err?.retryable === false) throw new UnrecoverableError(err.message);
    throw err;
  }
}

/** email: send one message; SMTP errors fail the job → retried with backoff. */
export async function processEmail(job: Job<{ mail: any }>) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { transporter } = require('../config/email');
  const info = await transporter.sendMail(job.data.mail);
  return { messageId: info?.messageId };
}

/**
 * storefront-rebuild: one build at a time (global concurrency 1). Requests still waiting when a
 * build starts are covered by it (the build reads the latest data), so they are drained first;
 * requests that arrive during the build stay queued → exactly one follow-up build.
 */
export function makeRebuildProcessor(queue: Queue) {
  return async (_job: Job) => {
    await queue.drain(true).catch(() => undefined);
    console.log('🚀 Starting atomic storefront deployment (queued job)...');
    const code = await runDeploy();
    if (code === 0) {
      console.log('✅ Atomic storefront deployment completed successfully.');
      return { exitCode: 0 };
    }
    if (code === EXIT_BUSY) throw new Error('deploy-store.sh busy (exit 75) — retrying');
    // A failed build (e.g. validation) will not succeed by retrying; the previous release stays live.
    throw new UnrecoverableError(`deploy-store.sh failed with exit ${code} — see CLIENT_DIR/logs/deploy-*.log`);
  };
}

export const MAINTENANCE_JOBS: Record<string, () => Promise<unknown>> = {
  'starshipit-tracking': refreshStarshipitTracking,
  'tagada-sync': scheduledTagadaSync,
  'db-backup': runDatabaseBackup,
  'abandoned-reminders': sendAbandonedCheckoutReminders,
};

/** maintenance: scheduled jobs, dispatched by job name. */
export async function processMaintenance(job: Job) {
  const fn = MAINTENANCE_JOBS[job.name];
  if (!fn) throw new UnrecoverableError(`unknown maintenance job: ${job.name}`);
  const result = await fn();
  console.log(`[Scheduled] ${job.name} done: ${JSON.stringify(result)}`);
  return result;
}
