import Redis from 'ioredis';

// REDIS_URL=disabled turns Redis off entirely (used by tests). Unset keeps the
// historical default of a local Redis on 6379.
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_DISABLED = process.env.REDIS_URL === 'disabled';

let client: Redis | null = null;
let isConnected = false;

/**
 * Get (or lazily create) the Redis client.
 * If Redis is unreachable, all cache methods become no-ops — the app never crashes.
 */
function getClient(): Redis | null {
  if (REDIS_DISABLED) return null;
  if (client) return client;

  try {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 3000,
    });

    // 'ready' (not 'connect'): with enableOfflineQueue=false, commands sent between
    // 'connect' and 'ready' are rejected.
    client.on('ready', () => {
      isConnected = true;
      console.log('[Cache] Redis connected');
    });
    client.on('end', () => {
      isConnected = false;
    });

    client.on('error', (err) => {
      if (isConnected) {
        console.warn('[Cache] Redis connection lost — falling back to no-cache mode:', err.message);
      }
      isConnected = false;
    });

    client.on('reconnecting', () => {
      console.log('[Cache] Redis reconnecting...');
    });

    client.connect().catch(() => {
      // Silent — error handler above already logs it
    });
  } catch (err) {
    console.warn('[Cache] Redis initialization failed — running without cache');
    client = null;
  }

  return client;
}

/**
 * Shared ioredis client (or null if disabled/failed). Used by the rate limiter store.
 */
export function getRedisClient(): Redis | null {
  return getClient();
}

/** True once the shared Redis client has an open connection. */
export function isRedisConnected(): boolean {
  return isConnected;
}

/**
 * Get a cached value by key.
 * Returns null if key not found or Redis is unavailable.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const redis = getClient();
    if (!redis || !isConnected) return null;

    const data = await redis.get(key);
    if (!data) return null;

    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Set a cached value by key with optional TTL (seconds).
 * Silently no-ops if Redis is unavailable.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
  try {
    const redis = getClient();
    if (!redis || !isConnected) return;

    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // Silent — caching is non-critical
  }
}

/**
 * Delete a cached key or a pattern of keys.
 * Use for cache invalidation after writes.
 */
export async function cacheDel(keyOrPattern: string): Promise<void> {
  try {
    const redis = getClient();
    if (!redis || !isConnected) return;

    if (keyOrPattern.includes('*')) {
      // Pattern deletion — scan and delete all matching keys
      const keys = await redis.keys(keyOrPattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } else {
      await redis.del(keyOrPattern);
    }
  } catch {
    // Silent
  }
}

/**
 * Build a consistent cache key from a base and query params.
 * e.g. cacheKey('products', { page: 1, limit: 20 }) => 'products:limit=20&page=1'
 */
export function cacheKey(base: string, params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) return base;
  const sorted = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return sorted ? `${base}:${sorted}` : base;
}

// Cache TTL constants (seconds)
export const TTL = {
  PRODUCTS_LIST: 5 * 60,     // 5 minutes
  PRODUCT_DETAIL: 10 * 60,   // 10 minutes
  STORE_SETTINGS: 10 * 60,   // 10 minutes
  ANALYTICS: 2 * 60,         // 2 minutes
  SHORT: 60,                  // 1 minute
  PUBLIC_CONTENT: 10 * 60,   // 10 minutes (collections, FAQs, CMS pages, COAs); cleared on every write
  STAFF_LIST: 60,            // 1 minute (admin product lists; separate keys, cleared on every write)
} as const;

/**
 * Record that `key` holds data for one entity (e.g. a product), in the Redis set `indexKey`,
 * so every cached variant of it (by slug, numeric id, ObjectId) can be cleared at once.
 */
export async function cacheIndexAdd(indexKey: string, key: string, ttlSeconds: number): Promise<void> {
  try {
    const redis = getClient();
    if (!redis || !isConnected) return;
    await redis.multi().sadd(indexKey, key).expire(indexKey, ttlSeconds + 60).exec();
  } catch {
    // Silent — caching is non-critical
  }
}

/** Delete every key recorded in the index set `indexKey`, and the set itself. */
export async function cacheDelIndexed(indexKey: string): Promise<void> {
  try {
    const redis = getClient();
    if (!redis || !isConnected) return;
    const keys = await redis.smembers(indexKey);
    await redis.del(...keys, indexKey);
  } catch {
    // Silent — caching is non-critical
  }
}
