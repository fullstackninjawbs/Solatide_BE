/**
 * Test harness. MUST be imported before anything from src/.
 *
 * Every environment variable that exists in Server/.env is overridden here with a
 * safe value, because some modules call dotenv.config() and dotenv never overrides
 * variables that are already set. Nothing in the tests connects to MongoDB, Redis,
 * SMTP, Tagada, Starshipit or Cloudinary: model statics are stubbed and mongoose
 * command buffering is disabled so any un-stubbed query fails immediately.
 */
import path from 'path';

const SAFE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '0',
  JWT_SECRET: 'test-only-jwt-secret-0123456789abcdef0123456789abcdef',
  JWT_EXPIRES_IN: '1h',
  // Throwaway local test DB (never actually connected by these tests)
  MONGO_URI: 'mongodb://127.0.0.1:27018/solatide_authtest?directConnection=true',
  REDIS_URL: 'disabled',
  CORS_ORIGIN: 'http://localhost:5173',
  TAGADA_ENV: 'sandbox',
  TAGADA_API_KEY_SANDBOX: '',
  TAGADA_API_KEY_PROD: '',
  TAGADA_WEBHOOK_SECRET: '',
  TAGADA_DEFAULT_CURRENCY: 'AUD',
  TAGADA_STORE_ID: '',
  TAGADA_ACCOUNT_ID: '',
  TAGADA_ORG_ID: '',
  TAGADA_CHECKOUT_URL: '',
  SMTP_HOST: 'invalid.localhost',
  SMTP_PORT: '2525',
  SMTP_SECURE: 'false',
  SMTP_USER: '',
  SMTP_PASS: '',
  SMTP_FROM_NAME: 'Test',
  SMTP_FROM_EMAIL: 'test@invalid.localhost',
  CLIENT_URL: 'http://localhost:5173',
  ADMIN_NOTIFICATION_EMAIL: 'admin@invalid.localhost',
  ADMIN_URL: 'http://localhost:5174',
  CLOUDINARY_CLOUD_NAME: 'testcloud',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
  STARSHIPIT_API_KEY: '',
  STARSHIPIT_SUBSCRIPTION_KEY: '',
  STARSHIPIT_WEBHOOK_SECRET: '',
  GOOGLE_ADDRESS_VALIDATION_API_KEY: '',
  CLIENT_DIR: path.join(__dirname, '__nonexistent_client_dir__'),
  TRUST_PROXY: 'false',
};
for (const [k, v] of Object.entries(SAFE_ENV)) process.env[k] = v;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';

export const TEST_JWT_SECRET = SAFE_ENV.JWT_SECRET;

export const signTestToken = (id: string) =>
  jwt.sign({ id }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

/** Start src/app.ts on an ephemeral port. */
export const startApp = async (): Promise<{ app: any; server: Server; base: string; close: () => Promise<void> }> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    app,
    server,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as any).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};

export const OID = (n: number) => n.toString(16).padStart(24, '0');

export type FakeUser = {
  _id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  password?: string;
  saved?: boolean;
  extra: Record<string, unknown>;
  save: () => Promise<FakeUser>;
  set: (k: string, v: unknown) => void;
  get: (k: string) => unknown;
};

export const fakeUser = (id: string, role: string, email = `${role}-${id.slice(-4)}@example.test`): FakeUser => {
  const u: FakeUser = {
    _id: id,
    name: `${role} user`,
    email,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    extra: {},
    async save() {
      u.saved = true;
      return u;
    },
    set(k: string, v: unknown) {
      u.extra[k] = v;
    },
    get(k: string) {
      return u.extra[k];
    },
  };
  return u;
};

/** Replace a model static, returning a restore function. */
export const stub = (model: any, name: string, impl: (...args: any[]) => any) => {
  const had = Object.prototype.hasOwnProperty.call(model, name);
  const original = model[name];
  model[name] = impl;
  return () => {
    if (had) model[name] = original;
    else delete model[name];
  };
};

/** A chainable, thenable fake mongoose Query resolving to `result`. */
export const fakeQuery = (result: unknown, calls: Record<string, unknown[]> = {}) => {
  const q: any = {};
  for (const m of ['select', 'sort', 'skip', 'limit', 'populate', 'lean', 'collation']) {
    q[m] = (...args: unknown[]) => {
      (calls[m] = calls[m] || []).push(args);
      return q;
    };
  }
  q.exec = () => Promise.resolve(result);
  q.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
  q.catch = (rej: any) => Promise.resolve(result).catch(rej);
  return q;
};

/** fetch with a timeout; resolves { status: 'timeout' } on abort. */
export const req = async (
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ status: number | 'timeout'; body: any; text: string }> => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 4000) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { status: 'timeout', body: null, text: '' };
    throw err;
  }
};
