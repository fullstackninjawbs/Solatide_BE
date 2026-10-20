import mongoose from 'mongoose';

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 15000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The driver's top-level message for a failed connect is always the generic "Could not connect
 * to any servers ... IP that isn't whitelisted" hint, whatever the real cause. The per-server
 * errors (timeout, connection closed, auth failure ...) are in `reason.servers`.
 */
const describeConnectError = (error: any): string => {
  const servers = error?.reason?.servers;
  if (servers instanceof Map && servers.size) {
    const details = [...servers.entries()].map(([host, sd]: [string, any]) =>
      `${host}: ${sd?.error?.message || sd?.type || 'unknown'}`
    );
    return details.join(' | ');
  }
  return error?.message || String(error);
};

export const isDbConnected = (): boolean => mongoose.connection.readyState === 1;

/** Resolves true as soon as MongoDB is connected, or false after `timeoutMs`. */
export const waitForDb = (timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (isDbConnected()) return resolve(true);
    const onConnected = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      mongoose.connection.off('connected', onConnected);
      resolve(false);
    }, timeoutMs);
    mongoose.connection.once('connected', onConnected);
  });

let listenersAttached = false;
let wasConnected = false;
const attachConnectionListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.setMaxListeners(0); // waitForDb adds one short-lived listener per waiting request
  mongoose.connection.on('connected', () => { wasConnected = true; });
  mongoose.connection.on('disconnected', () => {
    if (wasConnected) console.error('[Database] MongoDB disconnected — the driver will keep retrying.');
  });
  mongoose.connection.on('reconnected', () => console.log('[Database] MongoDB reconnected.'));
};

/**
 * Connects to MongoDB, retrying with backoff until it succeeds. It never exits the process:
 * during an Atlas outage the HTTP server stays up (answering 503, /api/health reports "disconnected")
 * instead of PM2 restarting every worker in a loop, which left nginx with no upstream (502).
 * Resolves once connected, so DB-backed startup (Tagada client, queue workers) runs after that.
 */
const connectDB = async (): Promise<void> => {
  const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/solatide';
  attachConnectionListeners();

  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await mongoose.connect(mongoURI, {
        maxPoolSize: 20,                // up from default 5 — handles more concurrent requests
        minPoolSize: 2,                 // keep warm connections: no new TLS handshake to Atlas after idle
        serverSelectionTimeoutMS: 5000, // fail fast if DB is unreachable
        socketTimeoutMS: 45000,         // prevent hanging queries
        // A server that stops answering (today's Atlas outage) is noticed by the heartbeat. Defaults
        // (check every 10 s, 30 s timeout) left requests hanging ~45 s; this marks it down in ≤ ~15 s,
        // which also interrupts the queries waiting on it (→ 503).
        heartbeatFrequencyMS: 5000,
        connectTimeoutMS: 10000,
      });
      console.log(`[Database] MongoDB Connected: ${conn.connection.host}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
      return;
    } catch (error) {
      const delay = Math.min(RETRY_MIN_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      console.error(`[Database] Error connecting to MongoDB (attempt ${attempt}): ${describeConnectError(error)} — retrying in ${delay / 1000}s`);
      await mongoose.disconnect().catch(() => undefined);
      await sleep(delay);
    }
  }
};

export default connectDB;
