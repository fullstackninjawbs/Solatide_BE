import { Request, Response } from 'express';
import { queuesEnabled, getProducerConnection } from './connection';
import { getQueue, QUEUE_NAMES, QueueName } from './queues';

const ALL: QueueName[] = Object.values(QUEUE_NAMES);

/** GET /api/admin/queues — job counts, recent failures and active schedules per queue. */
export async function getQueueStats(_req: Request, res: Response): Promise<void> {
  if (!queuesEnabled()) {
    res.json({ success: true, enabled: false, queues: [] });
    return;
  }
  try {
    const queues = await Promise.all(ALL.map(async (name) => {
      const q = getQueue(name);
      const [counts, failed, schedulers] = await Promise.all([
        q.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
        q.getFailed(0, 4),
        name === QUEUE_NAMES.maintenance ? q.getJobSchedulers(0, 20) : Promise.resolve([]),
      ]);
      return {
        name,
        counts,
        recentFailures: failed.map((j) => ({ id: j.id, name: j.name, attemptsMade: j.attemptsMade, failedReason: String(j.failedReason || '').slice(0, 300), finishedOn: j.finishedOn })),
        schedules: (schedulers as any[]).map((s) => ({ id: s.key || s.id, pattern: s.pattern, tz: s.tz, next: s.next })),
      };
    }));
    res.json({ success: true, enabled: true, redis: getProducerConnection().status, queues });
  } catch (err: any) {
    res.status(503).json({ success: false, message: `Queue backend unavailable: ${err?.message}` });
  }
}

/** POST /api/admin/queues/:name/retry-failed — move failed jobs back to waiting (no deletes). */
export async function retryFailedJobs(req: Request, res: Response): Promise<void> {
  const name = String(req.params.name) as QueueName;
  if (!queuesEnabled() || !ALL.includes(name)) {
    res.status(404).json({ success: false, message: 'Unknown queue' });
    return;
  }
  try {
    const before = await getQueue(name).getJobCounts('failed');
    await getQueue(name).retryJobs({ state: 'failed' });
    res.json({ success: true, retried: before.failed ?? 0 });
  } catch (err: any) {
    res.status(503).json({ success: false, message: `Queue backend unavailable: ${err?.message}` });
  }
}
