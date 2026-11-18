/**
 * Integration tests for order payment side effects / refunds / stock against a THROWAWAY local MongoDB.
 *
 *   npm run test:integration
 *
 * Uses ONLY mongodb://127.0.0.1:27018/solatide_paytest (override with PAYTEST_MONGO_URI,
 * which must still point at localhost and a *_paytest database). The database is dropped
 * at start and end. Email and address validation are stubbed — no network calls are made.
 * If the database is unreachable, the run fails (set ALLOW_INTEGRATION_SKIP=1 to skip instead).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

const TEST_URI = process.env.PAYTEST_MONGO_URI || 'mongodb://127.0.0.1:27018/solatide_paytest?directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[a-z_]*paytest(\?|$)/.test(TEST_URI)) {
  throw new Error(`Refusing to run integration tests against non-local / non-paytest database: ${TEST_URI}`);
}

// Must be set BEFORE app modules load: dotenv never overrides existing variables,
// so the real Server/.env values for these keys are not used.
process.env.MONGO_URI = TEST_URI;
process.env.JWT_SECRET = 'integration-test-secret-not-used-0123456789';
process.env.NODE_ENV = 'test';
// Never connect to any Redis from tests (Server/.env points at a real local instance).
process.env.REDIS_URL = 'disabled';

/* eslint-disable @typescript-eslint/no-var-requires */
const mongoose = require('mongoose');
const Order = require('../../src/models/order.model').default;
const Product = require('../../src/models/product.model').default;
const Customer = require('../../src/models/Customer').default;
const Refund = require('../../src/models/Refund').default;
const AnalyticsEvent = require('../../src/models/analyticsEvent.model').default;
const { setDefaultOnOrderPaidDeps, onOrderPaid } = require('../../src/services/orders/onOrderPaid');
const { reserveRefund, confirmReservedRefund } = require('../../src/services/orders/refunds');
const { decrementLineForOrder } = require('../../src/services/orders/inventory');
/* eslint-enable @typescript-eslint/no-var-requires */

// ─── Stubs ───────────────────────────────────────────────────────────────────
const calls = { confirmation: [] as string[], admin: [] as string[], address: [] as string[] };
setDefaultOnOrderPaidDeps({
  sendOrderConfirmationEmail: async (o: any) => { calls.confirmation.push(String(o._id)); },
  sendAdminNewOrderNotificationEmail: async (o: any) => { calls.admin.push(String(o._id)); },
  validateOrderAddress: async (id: any) => { calls.address.push(String(id)); },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function waitFor(fn: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}
const settle = () => new Promise((r) => setTimeout(r, 400));

let productSeq = 1;
async function makeProduct(stock: number) {
  const n = productSeq++;
  return Product.create({
    id: 900000 + n, name: `Test Peptide ${n}-${crypto.randomBytes(3).toString('hex')}`, price: 99, category: 'test',
    variants: [{ title: '5mg', price: 50, stockQty: stock, inventoryPolicy: 'deny', sku: `SKU${n}` }],
    stockQuantity: stock,
  });
}

async function makePendingOrder(product: any, extra: Record<string, unknown> = {}) {
  return Order.create({
    orderNumber: `SLT${crypto.randomInt(1000000, 9999999)}B`,
    paymentMethod: 'bank_transfer', paymentStatus: 'pending', status: 'pending',
    publicAccessToken: crypto.randomBytes(32).toString('hex'),
    products: [{ product: product._id, variant: product.variants[0]._id, quantity: 2, price: 50 }],
    subtotal: 100, grandTotal: 100, totalAmount: 100, currency: 'AUD',
    customerEmail: '', customerName: '',
    ...extra,
  });
}

const countFor = (arr: string[], id: unknown) => arr.filter((x) => x === String(id)).length;

// ─── Lifecycle ───────────────────────────────────────────────────────────────
let reachable = false;
let skipReason = '';
before(async () => {
  try {
    // autoCreate/autoIndex off: otherwise Mongoose starts creating collections on connect, racing
    // dropDatabase, and Model.init() memoizes that first (failed) attempt so retries can't recover.
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false });
    if (!/paytest$/.test(mongoose.connection.db.databaseName)) throw new Error('Refusing to reset a non-paytest database');
    await mongoose.connection.db.dropDatabase();
    for (const M of [Order, Product, Customer, Refund, AnalyticsEvent]) {
      for (let attempt = 1; ; attempt++) {
        try {
          await M.createCollection().catch((e: any) => { if (e?.codeName !== 'NamespaceExists') throw e; });
          await M.createIndexes(); // unique indexes are required by the idempotency tests
          break;
        } catch (e: any) {
          if (attempt >= 20 || !/being dropped/i.test(String(e?.message))) throw e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    reachable = true;
  } catch (err: any) {
    skipReason = `local test MongoDB not reachable at ${TEST_URI} (${err?.message}) — integration tests SKIPPED`;
    console.warn(`\n!!! ${skipReason}\n`);
    // Fail loudly by default so a silent skip is never reported as success; opt out with ALLOW_INTEGRATION_SKIP=1.
    if (process.env.ALLOW_INTEGRATION_SKIP !== '1') throw err;
  }
});

after(async () => {
  if (reachable) {
    await settle();
    if (!/paytest$/.test(mongoose.connection.db.databaseName)) throw new Error('Refusing to reset a non-paytest database');
    await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect().catch(() => undefined);
});

const itest = (name: string, fn: () => Promise<void>) =>
  test(name, async (t) => {
    if (!reachable) return t.skip(skipReason || 'mongo unreachable');
    await fn();
  });

// ─── (1) side effects exactly once ──────────────────────────────────────────
itest('concurrent onOrderPaid calls: side effects run exactly once', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product, { paymentStatus: 'paid', paidAt: new Date(), customerEmail: 'Buyer.One@Example.com' });
  const results = await Promise.all([onOrderPaid(order._id), onOrderPaid(order._id), onOrderPaid(order._id)]);
  assert.equal(results.filter((r: any) => r.claimed).length, 1, 'only one caller wins the claim');
  await waitFor(async () => !!(await Order.findById(order._id).lean())?.sideEffectsCompletedAt);
  await settle();
  const fresh = await Order.findById(order._id).lean();
  assert.equal(countFor(calls.confirmation, order._id), 1);
  // Bank transfer orders notify the admin when placed, not when marked paid
  assert.equal(countFor(calls.admin, order._id), 0);
  assert.equal((await Product.findById(product._id).lean()).variants[0].stockQty, 8);
  const cust = await Customer.findOne({ email: 'buyer.one@example.com' }).lean();
  assert.equal(cust?.orderCount, 1, 'customer upserted once with lowercased email');
  assert.equal(await AnalyticsEvent.countDocuments({ orderId: order._id, eventType: 'purchase', clientReported: false }), 1);
  assert.equal(fresh.sideEffectErrors, undefined);
});

itest('non-bank paid order (legacy card): admin notified exactly once', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product, { paymentMethod: 'tagada', paymentStatus: 'paid', paidAt: new Date(), customerEmail: 'card@example.com' });
  await Promise.all([onOrderPaid(order._id), onOrderPaid(order._id)]);
  await waitFor(async () => !!(await Order.findById(order._id).lean())?.sideEffectsCompletedAt);
  await settle();
  assert.equal(countFor(calls.admin, order._id), 1);
  assert.equal(countFor(calls.confirmation, order._id), 1);
});

itest('legacy paid order without paidAt is never re-processed', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product, { paymentStatus: 'paid', paidAt: null });
  const r = await onOrderPaid(order._id);
  assert.equal(r.claimed, false);
  assert.equal(countFor(calls.confirmation, order._id), 0);
});

itest('queue retry (resume): only failed steps re-run, no duplicate emails or stock', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product, { paymentStatus: 'paid', paidAt: new Date(), customerEmail: 'resume@example.com' });
  const sent = { confirmation: 0, admin: 0, address: 0 };
  let failConfirmation = true;
  const deps = {
    sendOrderConfirmationEmail: async () => { if (failConfirmation) throw new Error('SMTP down'); sent.confirmation++; },
    sendAdminNewOrderNotificationEmail: async () => { sent.admin++; },
    validateOrderAddress: async () => { sent.address++; },
  };

  // 1st attempt: confirmation email fails → order not completed, error recorded
  const first = await onOrderPaid(order._id, deps, { resume: true });
  assert.equal(first.claimed, true);
  assert.deepEqual(first.errors, ['confirmation_email']);
  let doc = await Order.findById(order._id).lean();
  assert.equal(doc.sideEffectsCompletedAt, null, 'not complete while a step failed');
  assert.ok(doc.sideEffectStepsDone.includes('inventory') && doc.sideEffectStepsDone.includes('customer_upsert'));
  assert.ok(!doc.sideEffectStepsDone.includes('admin_notification'), 'bank orders: admin notified at placement, not on paid');
  assert.ok(!doc.sideEffectStepsDone.includes('confirmation_email'));
  assert.equal((await Product.findById(product._id).lean()).variants[0].stockQty, 8);

  // Without resume (e.g. a second "mark paid") nothing re-runs
  assert.equal((await onOrderPaid(order._id, deps)).claimed, false);

  // 2nd attempt (queue retry): only the failed step runs
  failConfirmation = false;
  const second = await onOrderPaid(order._id, deps, { resume: true });
  assert.equal(second.claimed, true);
  assert.equal(second.resumed, true);
  assert.deepEqual(second.errors, []);
  doc = await Order.findById(order._id).lean();
  assert.ok(doc.sideEffectsCompletedAt, 'completed once all steps succeeded');
  assert.equal(sent.confirmation, 1, 'confirmation sent exactly once');
  assert.equal(sent.admin, 0, 'bank orders: no admin email on paid');
  assert.equal((await Product.findById(product._id).lean()).variants[0].stockQty, 8, 'stock not decremented twice');
  assert.equal(await Customer.countDocuments({ email: 'resume@example.com' }), 1);
  assert.equal((await Customer.findOne({ email: 'resume@example.com' }).lean()).orderCount, 1, 'customer orderCount not incremented twice');

  // A further resume does nothing (already complete)
  assert.equal((await onOrderPaid(order._id, deps, { resume: true })).claimed, false);
});

// ─── (2) legacy TagadaPay orders still validate ──────────────────────────────
itest('legacy TagadaPay order (paymentMethod tagada + legacy fields) still saves', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product, {
    paymentMethod: 'tagada', tagadaPaymentId: `cs_${crypto.randomBytes(6).toString('hex')}`, tagadaEnv: 'production', tagadaPaymentStatus: 'captured',
  });
  order.status = 'processing';
  await order.save();
  const fresh = await Order.findById(order._id).lean();
  assert.equal(fresh.paymentMethod, 'tagada');
  assert.equal(fresh.tagadaEnv, 'production');
  // New orders no longer get the legacy fields by default
  const plain = await makePendingOrder(product);
  const p = await Order.findById(plain._id).lean();
  assert.equal(p.tagadaEnv, undefined);
  assert.equal(p.tagadaPaymentId, undefined);
});

// ─── (3) refunds (record-only) ──────────────────────────────────────────────
itest('two concurrent 60 refunds on a 100 order: exactly one succeeds', async () => {
  const product = await makeProduct(10);
  const now = new Date();
  const order = await makePendingOrder(product, { paymentStatus: 'paid', paidAt: now, sideEffectsClaimedAt: now });
  const results = await Promise.all([reserveRefund(order._id, 60), reserveRefund(order._id, 60)]);
  assert.equal(results.filter(Boolean).length, 1);
  const fresh = await Order.findById(order._id).lean();
  assert.equal(fresh.refundedAmount, 60);
  assert.equal(fresh.pendingRefundAmount, 60);
  assert.equal(await reserveRefund(order._id, 40.01), null);

  // Recorded as done: the reservation leaves pending, the amount is not added twice.
  await confirmReservedRefund(order._id, 60);
  const after1 = await Order.findById(order._id).lean();
  assert.equal(after1.refundedAmount, 60);
  assert.equal(after1.pendingRefundAmount, 0);
});

// ─── (5) atomic stock ───────────────────────────────────────────────────────
itest('10 parallel decrements of 1 against stock 5 → 0 stock, 5 oversell flags', async () => {
  const product = await makeProduct(5);
  const order = await makePendingOrder(product);
  const vid = product.variants[0]._id;
  const results = await Promise.all(
    Array.from({ length: 10 }, () => decrementLineForOrder(order._id, { product: product._id, variant: vid, quantity: 1, sku: 'X' }))
  );
  assert.equal(results.filter((r: any) => r.ok).length, 5);
  const p = await Product.findById(product._id).lean();
  assert.equal(p.variants[0].stockQty, 0);
  assert.equal(p.stockQuantity, 0);
  assert.equal(p.inStock, false);
  const o = await Order.findById(order._id).lean();
  assert.equal(o.oversold, true);
  assert.equal(o.oversells.length, 5);
});
