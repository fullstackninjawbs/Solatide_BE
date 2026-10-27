import rateLimit, { MemoryStore, Options, Store, IncrementResponse, ClientRateLimitInfo } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient, isRedisConnected } from '../utils/cache';

/**
 * Store that uses Redis (shared across PM2 cluster workers) when REDIS_URL is
 * configured and the shared ioredis client is connected, and falls back to a
 * per-process MemoryStore otherwise (so a Redis outage never takes the API down).
 */
let warnedFallback = false;

class RedisWithMemoryFallbackStore implements Store {
  prefix: string;
  localKeys = false;
  private memory = new MemoryStore();
  private redis: RedisStore | null = null;
  private options: Options | null = null;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.options = options;
    this.memory.init(options);
  }

  private getRedisStore(): RedisStore | null {
    if (!process.env.REDIS_URL || process.env.REDIS_URL === 'disabled') return null;
    const client = getRedisClient();
    if (!client || !isRedisConnected() || client.status !== 'ready') {
      if (!warnedFallback) {
        warnedFallback = true;
        console.warn('[RateLimit] Redis not ready — using per-process memory store until it connects (checked on every request).');
      }
      return null;
    }
    if (!this.redis && this.options) {
      const store = new RedisStore({
        prefix: `rl:${this.prefix}:`,
        sendCommand: (command: string, ...args: string[]) => client.call(command, ...args) as any,
      });
      // Script loading happens eagerly; never let a rejection go unhandled, and
      // drop the store so it is rebuilt (scripts reloaded) on the next request.
      const reset = () => {
        if (this.redis === store) this.redis = null;
      };
      store.incrementScriptSha?.catch?.(reset);
      store.getScriptSha?.catch?.(reset);
      store.init(this.options);
      this.redis = store;
    }
    return this.redis;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const r = this.getRedisStore();
    if (r) {
      try {
        return await r.get(key);
      } catch {
        /* fall through */
      }
    }
    return this.memory.get(key);
  }

  async increment(key: string): Promise<IncrementResponse> {
    const r = this.getRedisStore();
    if (r) {
      try {
        return await r.increment(key);
      } catch (err) {
        console.warn('[RateLimit] Redis increment failed, using memory store:', (err as Error).message);
      }
    }
    return this.memory.increment(key);
  }

  async decrement(key: string): Promise<void> {
    const r = this.getRedisStore();
    if (r) {
      try {
        await r.decrement(key);
        return;
      } catch {
        /* fall through */
      }
    }
    await this.memory.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    const r = this.getRedisStore();
    if (r) {
      try {
        await r.resetKey(key);
      } catch {
        /* ignore */
      }
    }
    await this.memory.resetKey(key);
  }

  shutdown(): void {
    this.memory.shutdown();
  }
}

const makeLimiter = (name: string, windowMs: number, max: number, message: string, extra: Partial<Options> = {}) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
    store: new RedisWithMemoryFallbackStore(name),
    ...extra,
  });

/**
 * General API limiter — applied globally to all routes.
 */
export const generalLimiter = makeLimiter(
  'general',
  15 * 60 * 1000,
  2000,
  'Too many requests from this IP, please try again after 15 minutes.',
  {
    // Tagada webhook is secured by HMAC signature instead
    skip: (req) => req.path === '/api/payments/tagada/webhook',
  }
);

/**
 * Strict auth limiter — login/register/forgot/reset.
 */
export const authLimiter = makeLimiter(
  'auth',
  15 * 60 * 1000,
  10,
  'Too many authentication attempts, please try again after 15 minutes.'
);

/**
 * Public product limiter — high-traffic catalog endpoints.
 */
export const publicLimiter = makeLimiter('public', 15 * 60 * 1000, 3000, 'Too many requests, please try again shortly.');

/**
 * Placing an order / order request from the storefront checkout: 20 / 15 min / IP.
 */
export const checkoutLimiter = makeLimiter('checkout', 15 * 60 * 1000, 20, 'Too many checkout attempts, please wait a few minutes and try again.');

/**
 * Checking a discount code at checkout: 30 / 15 min / IP (stops guessing codes).
 */
export const discountCheckLimiter = makeLimiter('discount-check', 15 * 60 * 1000, 30, 'Too many discount code attempts, please wait a few minutes and try again.');

/**
 * Public form submissions (review creation, newsletter subscribe): 10/hour/IP.
 */
export const formSubmitLimiter = makeLimiter('forms', 60 * 60 * 1000, 10, 'Too many submissions, please try again later.');

/**
 * Public analytics ingestion: 300 events / 5 min / IP.
 */
export const analyticsLimiter = makeLimiter('analytics', 5 * 60 * 1000, 300, 'Too many analytics events.');
