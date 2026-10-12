import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, stub, req } from './helpers/setup';
import Order from '../src/models/order.model';

/** H-3 regression: Starshipit webhook requires the shared secret. */

let ctx: Awaited<ReturnType<typeof startApp>>;
let restore: () => void;
let lookups = 0;

before(async () => {
  restore = stub(Order, 'findOne', async () => {
    lookups++;
    return null;
  });
  ctx = await startApp();
});

after(async () => {
  restore();
  delete process.env.STARSHIPIT_WEBHOOK_SECRET;
  await ctx.close();
});

const payload = JSON.stringify({ order_number: 'SOL-00001', tracking_number: 'EVIL123', tracking_status: 'Dispatched' });
const post = (qs = '', headers: Record<string, string> = {}) =>
  req(ctx.base + '/api/v1/orders/webhook/starshipit' + qs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload,
  });

test('secret not configured → 503 (fail closed), order untouched', async () => {
  process.env.STARSHIPIT_WEBHOOK_SECRET = '';
  lookups = 0;
  const res = await post('', { 'x-starshipit-secret': 'anything' });
  assert.equal(res.status, 503);
  assert.equal(lookups, 0);
});

test('missing secret → 401, order untouched', async () => {
  process.env.STARSHIPIT_WEBHOOK_SECRET = 'correct-horse-battery-staple';
  lookups = 0;
  const res = await post();
  assert.equal(res.status, 401);
  assert.equal(lookups, 0);
});

test('wrong secret (header or query) → 401, order untouched', async () => {
  process.env.STARSHIPIT_WEBHOOK_SECRET = 'correct-horse-battery-staple';
  lookups = 0;
  const a = await post('', { 'x-starshipit-secret': 'wrong' });
  const b = await post('?token=correct-horse-battery-stapl');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(lookups, 0);
});

test('correct secret (header or ?token=) → accepted', async () => {
  process.env.STARSHIPIT_WEBHOOK_SECRET = 'correct-horse-battery-staple';
  lookups = 0;
  const a = await post('', { 'x-starshipit-secret': 'correct-horse-battery-staple' });
  const b = await post('?token=correct-horse-battery-staple');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lookups, 2);
});
