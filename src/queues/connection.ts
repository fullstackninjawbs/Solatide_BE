import IORedis, { RedisOptions } from 'ioredis';
import type { ConnectionOptions } from 'bullmq';

/**
 * BullMQ background jobs (queues + workers) on the existing Redis.
 *
 * Disabled — callers fall back to the previous in-process behaviour — when:
 *  - NODE_ENV=test, REDIS_URL=disabled, or QUEUES_ENABLED=false
 *  - Redis is unreachable at the moment a job is added (producer connection is fail-fast)
 */
export function queuesEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.REDIS_URL === 'disabled') return false;
  if (process.env.QUEUES_ENABLED === 'false') return false;
  return true;
}

export const QUEUE_PREFIX = 'solatide';

function redisUrl(): string {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

/** ioredis options from REDIS_URL (redis:// or rediss://, optional user/password/db). */
function baseOptions(): RedisOptions {
  const u = new URL(redisUrl());
  const db = u.pathname && u.pathname.length > 1 ? parseInt(u.pathname.slice(1), 10) : 0;
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: Number.isFinite(db) ? db : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

let producerConnection: IORedis | null = null;

/**
 * Connection for adding jobs. Fail-fast (no offline queue), so an add() while Redis is down
 * rejects immediately and the caller falls back instead of hanging.
 */
export function getProducerConnection(): IORedis {
  if (!producerConnection) {
    producerConnection = new IORedis({
      ...baseOptions(),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    producerConnection.on('error', () => undefined); // logged via add() failures; avoid noisy unhandled errors
  }
  return producerConnection;
}

export function producerReady(): boolean {
  return !!producerConnection && producerConnection.status === 'ready';
}

/** Connection options for Workers (blocking commands need maxRetriesPerRequest: null). */
export function workerConnectionOptions(): ConnectionOptions {
  // BullMQ ships its own RedisOptions typing; the runtime shape is the same ioredis options.
  return { ...baseOptions(), maxRetriesPerRequest: null } as unknown as ConnectionOptions;
}

export async function closeProducerConnection(): Promise<void> {
  if (producerConnection) {
    const c = producerConnection;
    producerConnection = null;
    await c.quit().catch(() => c.disconnect());
  }
}
