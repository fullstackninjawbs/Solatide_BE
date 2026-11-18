/**
 * Live analytics bus: storefront activity → every admin watching the live dashboard.
 *
 * The API runs as several PM2 cluster workers. A visitor's events reach one worker, the admin's live
 * stream is held by another, so messages go through Redis pub/sub (the Redis the queues already
 * use): every worker publishes to one channel and every worker that has live listeners subscribes.
 *
 * Without Redis (tests, REDIS_URL=disabled, Redis down) messages are delivered inside the current
 * process only. The admin page also re-reads a snapshot when it reconnects and once a minute, so a
 * message missed while Redis was unavailable is corrected shortly after.
 */
import { EventEmitter } from 'events';
import IORedis from 'ioredis';
import { getProducerConnection, QUEUE_PREFIX } from '../../../queues/connection';

export const LIVE_CHANNEL = `${QUEUE_PREFIX}:analytics:live`;

export interface LiveMessage {
  type: 'update';
  [key: string]: unknown;
}
type Listener = (msg: LiveMessage) => void;

const local = new EventEmitter();
local.setMaxListeners(0);

let subscriber: IORedis | null = null;

function redisEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.REDIS_URL !== 'disabled';
}

function deliver(raw: string) {
  try {
    local.emit('message', JSON.parse(raw));
  } catch { /* malformed: ignore */ }
}

/** Dedicated subscriber connection (a subscribed connection can't run other commands). */
function ensureSubscriber() {
  if (subscriber || !redisEnabled()) return;
  const producer = getProducerConnection();
  subscriber = producer.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null, lazyConnect: false });
  subscriber.on('error', () => undefined); // reconnects by itself; the page falls back to snapshots
  subscriber.on('message', (_channel: string, raw: string) => deliver(raw));
  subscriber.subscribe(LIVE_CHANNEL).catch(() => undefined);
}

/** True when this process receives messages through Redis right now. */
function subscribedViaRedis(): boolean {
  return !!subscriber && subscriber.status === 'ready';
}

/**
 * The shared Redis connection is opened on first use, so the first message after a worker starts
 * would find it still connecting. Wait briefly for it instead of delivering only locally.
 */
function whenReady(conn: IORedis, ms: number): Promise<boolean> {
  if (conn.status === 'ready') return Promise.resolve(true);
  if (conn.status === 'end' || conn.status === 'close') return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (v: boolean) => { clearTimeout(timer); conn.off('ready', onReady); resolve(v); };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    conn.once('ready', onReady);
  });
}
const CONNECT_WAIT_MS = 1500;

/** Announces a message to every live listener on every worker. Never throws. */
export async function publish(msg: LiveMessage): Promise<void> {
  const raw = JSON.stringify(msg);
  if (redisEnabled()) {
    try {
      const producer = getProducerConnection();
      if (await whenReady(producer, CONNECT_WAIT_MS)) {
        await producer.publish(LIVE_CHANNEL, raw);
        // Our own subscriber delivers it locally; if it is not connected, deliver it here directly
        if (!subscribedViaRedis()) deliver(raw);
        return;
      }
    } catch { /* fall through: local delivery */ }
  }
  deliver(raw);
}

/** Registers a listener; returns the function that removes it. */
export function subscribe(listener: Listener): () => void {
  ensureSubscriber();
  local.on('message', listener);
  return () => local.off('message', listener);
}

/** Whether anyone in this process is listening. */
export function hasLocalListeners(): boolean {
  return local.listenerCount('message') > 0;
}

// Live viewers on any worker: each open admin stream refreshes this key (markViewerPresent), so
// workers skip building messages while nobody is watching. Cached briefly per process.
const VIEWERS_KEY = `${LIVE_CHANNEL}:viewers`;
const VIEWERS_TTL_S = 60;
const VIEWERS_CACHE_MS = 5000;
let viewersCache = { at: 0, value: false };

export async function markViewerPresent(): Promise<void> {
  if (!redisEnabled()) return;
  try {
    const producer = getProducerConnection();
    if (await whenReady(producer, CONNECT_WAIT_MS)) await producer.set(VIEWERS_KEY, '1', 'EX', VIEWERS_TTL_S);
  } catch { /* best effort */ }
}

/** True when an admin may be watching on this or another worker (errs towards true). */
export async function anyViewers(): Promise<boolean> {
  if (hasLocalListeners()) return true;
  if (!redisEnabled()) return false;
  if (Date.now() - viewersCache.at < VIEWERS_CACHE_MS) return viewersCache.value;
  let value = true;
  try {
    const producer = getProducerConnection();
    if (await whenReady(producer, CONNECT_WAIT_MS)) value = (await producer.exists(VIEWERS_KEY)) === 1;
  } catch { value = true; }
  viewersCache = { at: Date.now(), value };
  return value;
}

export async function closeLiveBus(): Promise<void> {
  local.removeAllListeners('message');
  if (subscriber) {
    const s = subscriber;
    subscriber = null;
    await s.quit().catch(() => s.disconnect());
  }
}
