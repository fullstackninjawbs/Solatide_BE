import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * Starshipit HTTP helper: rate limiting + safe retries.
 *
 * Rate limit: calls from this process are spaced at least MIN_INTERVAL_MS apart (Starshipit
 * throttles bursts; bulk label creation used to fire calls back-to-back).
 *
 * Retries (up to 3 attempts, 1 s / 3 s backoff, honouring Retry-After):
 *  - always on 429 / 503 (request was not processed)
 *  - on 502 / 504 and network errors only for requests that are safe to repeat
 *    (GET, and POST /orders/shipment which re-prints the same order's label).
 *    POST /orders (create) is NOT repeated on those, so a slow-but-successful create
 *    can never produce a duplicate Starshipit order.
 */
const MIN_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];

let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  chain = run.catch(() => undefined);
  return run.then(fn);
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE']);

function retryDelay(err: any, attempt: number): number {
  const ra = err?.response?.headers?.['retry-after'];
  const secs = ra ? parseInt(String(ra), 10) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 15_000);
  return BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
}

function shouldRetry(err: any, repeatable: boolean): boolean {
  const status = err?.response?.status;
  if (status === 429 || status === 503) return true;
  if (!repeatable) return false;
  if (status === 502 || status === 504) return true;
  return !err?.response && NETWORK_CODES.has(err?.code);
}

export async function starshipitRequest<T = any>(
  method: 'get' | 'post',
  url: string,
  data: unknown,
  config: AxiosRequestConfig,
  opts: { repeatable: boolean }
): Promise<AxiosResponse<T>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await throttle(() => (method === 'get' ? axios.get<T>(url, config) : axios.post<T>(url, data, config)));
    } catch (err: any) {
      if (attempt >= MAX_ATTEMPTS || !shouldRetry(err, opts.repeatable)) throw err;
      const delay = retryDelay(err, attempt);
      console.warn(`[Starshipit] ${method.toUpperCase()} ${url.replace(/^https?:\/\/[^/]+/, '')} failed (${err?.response?.status ?? err?.code}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
