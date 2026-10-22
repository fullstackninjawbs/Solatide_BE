import { Worker } from 'bullmq';
import { queuesEnabled, workerConnectionOptions, QUEUE_PREFIX, getProducerConnection } from './connection';
import { getQueue, QUEUE_NAMES } from './queues';
import { processOrderPaid, processEmail, makeRebuildProcessor, processMaintenance, MAINTENANCE_JOBS } from './processors';

/**
 * Background workers. By default they run inside the API process, in the first PM2 instance
 * only (NODE_APP_INSTANCE 0), so there is nothing extra to deploy. RUN_WORKERS:
 *   api      (default) — first API instance runs the workers
 *   separate           — only `node dist/worker.js` runs them (add it as its own PM2 app)
 *   off                — no workers anywhere (jobs wait in Redis; producers still enqueue)
 */
export function shouldRunWorkersInApi(): boolean {
  if (!queuesEnabled()) return false;
  const mode = (process.env.RUN_WORKERS || 'api').toLowerCase();
  if (mode !== 'api') return false;
  const instance = process.env.NODE_APP_INSTANCE;
  return instance === undefined || instance === '0';
}

/** Cron schedules for the maintenance queue — each job only runs when its env var is set. */
const SCHEDULES: Array<{ id: keyof typeof MAINTENANCE_JOBS; env: string; extraCheck?: () => string | null; defaultPattern?: string }> = [
  { id: 'starshipit-tracking', env: 'STARSHIPIT_TRACKING_CRON' },
  { id: 'tagada-sync', env: 'TAGADA_SYNC_CRON' },
  { id: 'db-backup', env: 'BACKUP_CRON', extraCheck: () => (process.env.BACKUP_MONGO_URI ? null : 'BACKUP_MONGO_URI is not set') },
  { id: 'abandoned-reminders', env: 'ABANDONED_REMINDER_CRON' },
  // On by default: unpaid bank transfer / PayID orders must not hold stock forever ("off" disables)
  { id: 'cancel-unpaid-orders', env: 'UNPAID_ORDER_CANCEL_CRON', defaultPattern: '20 * * * *' },
];

let workers: Worker[] = [];

async function registerSchedules(): Promise<void> {
  const q = getQueue(QUEUE_NAMES.maintenance);
  const tz = process.env.SCHEDULE_TZ || 'Australia/Melbourne';
  for (const s of SCHEDULES) {
    const raw = (process.env[s.env] || '').trim();
    const pattern = raw.toLowerCase() === 'off' ? '' : raw || s.defaultPattern || '';
    const problem = pattern ? s.extraCheck?.() ?? null : null;
    if (pattern && !problem) {
      await q.upsertJobScheduler(s.id, { pattern, tz }, { name: s.id });
      console.log(`[Queue] scheduled ${s.id}: "${pattern}" (${tz})`);
    } else {
      // Not configured: make sure no schedule from an earlier configuration keeps running
      await q.removeJobScheduler(s.id).catch(() => undefined);
      if (problem) console.warn(`[Queue] ${s.id} not scheduled: ${problem}`);
    }
  }
}

/** BullMQ needs Redis not to evict keys (an evicted job = a lost email / order follow-up). */
async function warnIfRedisEvicts(): Promise<void> {
  try {
    const res = (await getProducerConnection().config('GET', 'maxmemory-policy')) as unknown as string[];
    const policy = Array.isArray(res) ? res[1] : '';
    if (policy && policy !== 'noeviction') {
      console.warn(`[Queue] ⚠️  Redis maxmemory-policy is "${policy}". Background jobs can be evicted — set it to "noeviction" (redis-cli CONFIG SET maxmemory-policy noeviction, and in redis.conf).`);
    }
  } catch {
    // CONFIG may be disabled on managed Redis; BullMQ also warns on its own
  }
}

export async function startWorkers(): Promise<void> {
  if (!queuesEnabled() || workers.length) return;
  await warnIfRedisEvicts();
  const common = { connection: workerConnectionOptions(), prefix: QUEUE_PREFIX };
  const rebuildQueue = getQueue(QUEUE_NAMES.rebuild);
  await rebuildQueue.setGlobalConcurrency(1).catch(() => undefined);

  workers = [
    new Worker(QUEUE_NAMES.orders, processOrderPaid, { ...common, concurrency: 2 }),
    new Worker(QUEUE_NAMES.email, processEmail, { ...common, concurrency: 3, limiter: { max: 5, duration: 1000 } }),
    // Builds take minutes: long lock so the job is not considered stalled mid-build
    new Worker(QUEUE_NAMES.rebuild, makeRebuildProcessor(rebuildQueue), { ...common, concurrency: 1, lockDuration: 10 * 60 * 1000 }),
    new Worker(QUEUE_NAMES.maintenance, processMaintenance, { ...common, concurrency: 1, lockDuration: 30 * 60 * 1000 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => {
      const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
      console.error(`[Queue] ${w.name}/${job?.name} ${job?.id ?? ''} failed (attempt ${job?.attemptsMade ?? '?'}${final ? ', final' : ''}): ${err?.message}`);
    });
    w.on('error', (err) => console.error(`[Queue] worker ${w.name} error: ${err?.message}`));
  }
  try {
    await registerSchedules();
  } catch (err: any) {
    console.error(`[Queue] could not register schedules: ${err?.message}`);
  }
  console.log(`[Queue] workers started (pid ${process.pid}): ${workers.map((w) => w.name).join(', ')}`);
}

/** Stop taking new jobs; give running jobs a few seconds to finish (a long build is resumed later). */
export async function stopWorkers(timeoutMs = 8000): Promise<void> {
  if (!workers.length) return;
  const all = workers;
  workers = [];
  await Promise.race([
    Promise.all(all.map((w) => w.close())),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  await Promise.all(all.map((w) => w.close(true).catch(() => undefined)));
}
