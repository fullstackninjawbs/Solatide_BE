import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let client: Redis | null = null;
let isConnected = false;

/**
 * Get (or lazily create) the Redis client.
 * If Redis is unreachable, all cache methods become no-ops — the app never crashes.
 */
function getClient(): Redis | null {
  if (client) return client;

  try {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 3000,
    });

    client.on('connect', () => {
      isConnected = true;
      console.log('[Cache] Redis connected');
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
} as const;
