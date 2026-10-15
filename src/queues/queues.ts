import { Queue, JobsOptions } from 'bullmq';
import { getProducerConnection, QUEUE_PREFIX } from './connection';

export const QUEUE_NAMES = {
  orders: 'order-side-effects',
  email: 'email',
  rebuild: 'storefront-rebuild',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Keep finished jobs for inspection (admin queue stats), but bounded. */
const KEEP_COMPLETED = { age: 7 * 24 * 3600, count: 1000 };
const KEEP_FAILED = { age: 30 * 24 * 3600, count: 1000 };

export const DEFAULT_JOB_OPTIONS: Record<QueueName, JobsOptions> = {
  // Order side effects: retried (only the failed steps re-run, see onOrderPaid resume)
  [QUEUE_NAMES.orders]: { attempts: 6, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED },
  // Emails: SMTP hiccups are retried for ~1 h in total. Jobs hold the recipient + message, so
  // sent ones are kept only briefly (1 h); failed ones 7 days for inspection / retry.
  [QUEUE_NAMES.email]: { attempts: 6, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: { age: 3600, count: 200 }, removeOnFail: { age: 7 * 24 * 3600, count: 500 } },
  // Storefront rebuild: busy (exit 75) is retried; a failed build is not (UnrecoverableError)
  [QUEUE_NAMES.rebuild]: { attempts: 5, backoff: { type: 'fixed', delay: 60_000 }, removeOnComplete: { age: 7 * 24 * 3600, count: 200 }, removeOnFail: KEEP_FAILED },
  // Scheduled maintenance jobs
  [QUEUE_NAMES.maintenance]: { attempts: 3, backoff: { type: 'exponential', delay: 120_000 }, removeOnComplete: { age: 7 * 24 * 3600, count: 500 }, removeOnFail: KEEP_FAILED },
};

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getProducerConnection(), prefix: QUEUE_PREFIX, defaultJobOptions: DEFAULT_JOB_OPTIONS[name] });
    q.on('error', () => undefined); // connection errors surface as add() rejections
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  const all = [...queues.values()];
  queues.clear();
  await Promise.all(all.map((q) => q.close().catch(() => undefined)));
}
