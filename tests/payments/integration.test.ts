/**
 * Integration tests for payment/order remediation against a THROWAWAY local MongoDB.
 *
 *   npx ts-node --transpile-only tests/payments/integration.test.ts
 *
 * Uses ONLY mongodb://127.0.0.1:27018/solatide_paytest (override with PAYTEST_MONGO_URI,
 * which must still point at localhost and a *_paytest database). The database is dropped
 * at start and end. Tagada and email are stubbed — no network calls are made.
 * If the database is unreachable (2 s), every test is skipped with a clear message.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

const TEST_URI = process.env.PAYTEST_MONGO_URI || 'mongodb://127.0.0.1:27018/solatide_paytest?directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[a-z_]*paytest(\?|$)/.test(TEST_URI)) {
  throw new Error(`Refusing to run integration tests against non-local / non-paytest database: ${TEST_URI}`);
}
const WEBHOOK_SECRET = 'whsec_integration_test';

// Must be set BEFORE app modules load: dotenv never overrides existing variables,
// so the real Server/.env values for these keys are not used.
process.env.MONGO_URI = TEST_URI;
process.env.JWT_SECRET = 'integration-test-secret-not-used-0123456789';
process.env.TAGADA_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.TAGADA_ENV = 'sandbox';
process.env.TAGADA_API_KEY_SANDBOX = 'stub';
process.env.TAGADA_API_KEY_PROD = 'stub';
process.env.NODE_ENV = 'test';
// Never connect to any Redis from tests (Server/.env points at a real local instance).
process.env.REDIS_URL = 'disabled';

/* eslint-disable @typescript-eslint/no-var-requires */
const mongoose = require('mongoose');
const tagadaClientModule = require('../../src/services/tagadaClient');
const Order = require('../../src/models/order.model').default;
const Product = require('../../src/models/product.model').default;
const Customer = require('../../src/models/Customer').default;
const Refund = require('../../src/models/Refund').default;
const AnalyticsEvent = require('../../src/models/analyticsEvent.model').default;
const ProcessedWebhookEvent = require('../../src/models/ProcessedWebhookEvent').default;
const { setDefaultOnOrderPaidDeps, onOrderPaid } = require('../../src/services/orders/onOrderPaid');
const { reserveRefund } = require('../../src/services/orders/refunds');
const { decrementLineForOrder } = require('../../src/services/orders/inventory');
const { tagadaWebhook, syncTagadaOrder } = require('../../src/controllers/payment.controller');
/* eslint-enable @typescript-eslint/no-var-requires */

// ─── Stubs ───────────────────────────────────────────────────────────────────
const calls = { confirmation: [] as string[], admin: [] as string[], address: [] as string[], tagada: 0 };
setDefaultOnOrderPaidDeps({
  sendOrderConfirmationEmail: async (o: any) => { calls.confirmation.push(String(o._id)); },
  sendAdminNewOrderNotificationEmail: async (o: any) => { calls.admin.push(String(o._id)); },
  validateOrderAddress: async (id: any) => { calls.address.push(String(id)); },
  deactivatePromotion: async () => undefined,
  refreshOrderDetails: async () => undefined,
});

const tagadaObjects = new Map<string, any>();
const fakeTagada = {
  checkout: { retrieveSession: async (id: string) => { calls.tagada++; return { session: tagadaObjects.get(id) ?? { status: 'pending' } }; } },
  orders: { retrieve: async (id: string) => { calls.tagada++; return { order: tagadaObjects.get(id) ?? { status: 'pending' } }; } },
  payments: { refund: async () => ({ refund: { id: 'rf_stub' } }) },
  promotions: { update: async () => ({}) },
};
tagadaClientModule.getTagadaClient = async () => fakeTagada;

// ─── Helpers ─────────────────────────────────────────────────────────────────
type Res = { status: number; body: any };
function invoke(handler: any, req: any): Promise<Res> {
  return new Promise((resolve) => {
    const res: any = {
      statusCode: 200, headersSent: false,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); return this; },
      send(b: any) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); return this; },
    };
    handler(req, res, (err: any) => resolve({ status: err?.statusCode ?? 500, body: { error: err?.message } }));
  });
}

function webhookReq(payload: any, opts: { secret?: string } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(raw).digest('hex');
  return { headers: { 'x-tagadapay-signature': `sha256=${sig}` }, rawBody: raw, body: raw };
}

const sendWebhook = (payload: any) => invoke(tagadaWebhook, webhookReq(payload));
const sync = (orderId: string, token: string | undefined) =>
  invoke(syncTagadaOrder, { params: { orderId }, query: { accessToken: token }, body: {} });

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
    variants: [{ title: '5mg', price: 50, stockQty: stock, inventoryPolicy: 'deny', tagadaVariantId: `tv_${n}`, sku: `SKU${n}` }],
    stockQuantity: stock,
  });
}

async function makePendingOrder(product: any, extra: Record<string, unknown> = {}) {
  return Order.create({
    orderNumber: `SLT${crypto.randomInt(1000000, 9999999)}B`,
    paymentMethod: 'tagada', paymentStatus: 'pending', status: 'pending',
    tagadaPaymentId: `cs_${crypto.randomBytes(6).toString('hex')}`,
    publicAccessToken: crypto.randomBytes(32).toString('hex'),
    products: [{ product: product._id, variant: product.variants[0]._id, quantity: 2, price: 50 }],
    subtotal: 100, grandTotal: 100, totalAmount: 100, currency: 'AUD',
    customerEmail: '', customerName: '',
    ...extra,
  });
}

function paidTagadaObject(email: string) {
  return {
    status: 'paid',
    customer: { email, firstName: 'Ada', lastName: 'Lovelace' },
    shippingAddress: { firstName: 'Ada', lastName: 'Lovelace', address1: '1 Test St', city: 'Sydney', province: 'NSW', zip: '2000', country: 'AU' },
    summaries: [{ subtotalAmount: 10000, totalAdjustedAmount: 10000, currency: 'AUD' }],
  };
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
    for (const M of [Order, Product, Customer, Refund, AnalyticsEvent, ProcessedWebhookEvent]) {
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
itest('sync-then-webhook: side effects run exactly once', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product);
  tagadaObjects.set(order.tagadaPaymentId, paidTagadaObject('Buyer.One@Example.com'));

  const bad = await sync(String(order._id), 'wrong-token');
  assert.equal(bad.status, 404, 'sync must require the access token');
  const none = await sync(String(order._id), undefined);
  assert.equal(none.status, 404);

  const s = await sync(String(order._id), order.publicAccessToken);
  assert.equal(s.status, 200);
  assert.equal(s.body.data.order.paymentStatus, 'paid');
  assert.equal(s.body.data.order.customer, undefined, 'sync must not return PII');
  assert.equal(s.body.data.order.shippingAddressObj, undefined);

  const w = await sendWebhook({ type: 'order/paid', data: { cartToken: String(order._id), status: 'paid', orderId: `ord_${order._id}` } });
  assert.equal(w.status, 200);

  await waitFor(async () => !!(await Order.findById(order._id).lean())?.sideEffectsCompletedAt);
  await settle();
  const fresh = await Order.findById(order._id).lean();
  assert.equal(countFor(calls.confirmation, order._id), 1);
  assert.equal(countFor(calls.admin, order._id), 1);
  assert.equal((await Product.findById(product._id).lean()).variants[0].stockQty, 8);
  const cust = await Customer.findOne({ email: 'buyer.one@example.com' }).lean();
  assert.equal(cust?.orderCount, 1, 'customer upserted once with lowercased email');
  assert.equal(await AnalyticsEvent.countDocuments({ orderId: order._id, eventType: 'purchase', clientReported: false }), 1);
  assert.ok(fresh.paidAt);
  assert.equal(fresh.status, 'processing');
  assert.equal(fresh.sideEffectErrors, undefined);
});

itest('webhook-then-sync: side effects run exactly once', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product);
  tagadaObjects.set(order.tagadaPaymentId, paidTagadaObject('buyer2@example.com'));

  const w = await sendWebhook({ type: 'payment/succeeded', data: { cartToken: String(order._id), status: 'captured', paymentId: `pay_${order._id}` } });
  assert.equal(w.status, 200);
  const s = await sync(String(order._id), order.publicAccessToken);
  assert.equal(s.status, 200);
  assert.equal(s.body.data.order.paymentStatus, 'paid');

  await waitFor(async () => !!(await Order.findById(order._id).lean())?.sideEffectsCompletedAt);
  await settle();
  assert.equal(countFor(calls.confirmation, order._id), 1);
  assert.equal(countFor(calls.admin, order._id), 1);
  assert.equal((await Product.findById(product._id).lean()).variants[0].stockQty, 8);
  assert.equal((await Order.findById(order._id).lean()).tagadaProviderPaymentId, `pay_${order._id}`);
});

itest('concurrent sync + webhook + direct calls: side effects still once', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product);
  tagadaObjects.set(order.tagadaPaymentId, paidTagadaObject('buyer3@example.com'));
  await Promise.all([
    sync(String(order._id), order.publicAccessToken),
    sendWebhook({ type: 'order/paid', data: { cartToken: String(order._id), status: 'paid', n: 1 } }),
    sendWebhook({ type: 'payment/succeeded', data: { cartToken: String(order._id), status: 'captured', n: 2 } }),
  ]);
  await waitFor(async () => !!(await Order.findById(order._id).lean())?.sideEffectsCompletedAt);
  const extra = await Promise.all([onOrderPaid(order._id), onOrderPaid(order._id)]);
  assert.deepEqual(extra.map((r: any) => r.claimed), [false, false]);
  await settle();
  assert.equal(countFor(calls.confirmation, order._id), 1);
  assert.equal((await Product.findById(product._id).lean()).variants[0].stockQty, 8);
});

itest('legacy paid order without paidAt is never re-processed', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product, { paymentStatus: 'paid', paidAt: null });
  const r = await onOrderPaid(order._id);
  assert.equal(r.claimed, false);
  assert.equal(countFor(calls.confirmation, order._id), 0);
});

// ─── (2) duplicate webhook event ────────────────────────────────────────────
itest('duplicate webhook delivery is processed once', async () => {
  const product = await makeProduct(10);
  const order = await makePendingOrder(product);
  const payload = { type: 'payment/failed', data: { cartToken: String(order._id), status: 'declined' } };
  const first = await sendWebhook(payload);
  const second = await sendWebhook(payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, undefined);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(await ProcessedWebhookEvent.countDocuments({ order: order._id }), 1);
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'failed');

  const forged = await invoke(tagadaWebhook, webhookReq(payload, { secret: 'wrong' }));
  assert.equal(forged.status, 401);
});

// ─── (3) no state regression ────────────────────────────────────────────────
itest('shipped order + repeated paid / late failed events keep fulfilment state', async () => {
  const product = await makeProduct(10);
  const now = new Date();
  const order = await makePendingOrder(product, {
    paymentStatus: 'paid', paidAt: now, sideEffectsClaimedAt: now, sideEffectsCompletedAt: now,
    status: 'shipped', fulfilmentStatus: 'fulfilled', deliveryStatus: 'in_transit', trackingNumber: 'TRK1',
  });
  const r1 = await sendWebhook({ type: 'order/paid', data: { cartToken: String(order._id), status: 'paid', v: 1 } });
  const r2 = await sendWebhook({ type: 'payment/failed', data: { cartToken: String(order._id), status: 'declined', v: 2 } });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  await settle();
  const fresh = await Order.findById(order._id).lean();
  assert.equal(fresh.paymentStatus, 'paid');
  assert.equal(fresh.status, 'shipped');
  assert.equal(fresh.fulfilmentStatus, 'fulfilled');
  assert.equal(fresh.deliveryStatus, 'in_transit');
  assert.equal(countFor(calls.confirmation, order._id), 0);
});

// ─── (H-7) deterministic lookup ─────────────────────────────────────────────
itest('webhook refuses ambiguous matches and ignores "unknown" ids', async () => {
  const product = await makeProduct(10);
  const a = await makePendingOrder(product, { tagadaOrderId: 'ord_dup' });
  const b = await makePendingOrder(product, { tagadaOrderId: 'ord_dup' });
  const amb = await sendWebhook({ type: 'order/paid', data: { orderId: 'ord_dup', status: 'paid' } });
  assert.equal(amb.status, 202);
  assert.equal(amb.body.matched, false);
  for (const o of [a, b]) assert.equal((await Order.findById(o._id).lean()).paymentStatus, 'pending');

  const legacy = await makePendingOrder(product, { tagadaPaymentId: null });
  const unk = await sendWebhook({ type: 'order/paid', data: { checkoutSessionId: 'unknown', paymentId: 'unknown', status: 'paid' } });
  assert.equal(unk.status, 200);
  assert.equal(unk.body.matched, false);
  assert.equal((await Order.findById(legacy._id).lean()).paymentStatus, 'pending');

  // Several orders may have tagadaPaymentId null (partial unique index on strings only).
  await makePendingOrder(product, { tagadaPaymentId: null });
});

// ─── (4) refunds ────────────────────────────────────────────────────────────
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

  // Webhook confirms the pending refund by tagadaRefundId without adding the amount twice.
  await Refund.create({ order: order._id, amount: 60, type: 'partial', status: 'pending', tagadaRefundId: 'rf_conf_1' });
  const payload = (n: number) => ({
    type: 'payment/refunded',
    data: { cartToken: String(order._id), status: 'partially_refunded', n,
      transactions: [{ id: 'rf_conf_1', type: 'refund', status: 'succeeded', amount: 6000 }] },
  });
  assert.equal((await sendWebhook(payload(1))).status, 200);
  assert.equal((await sendWebhook(payload(2))).status, 200); // different body → not deduped; must still not double count
  const after1 = await Order.findById(order._id).lean();
  assert.equal(after1.refundedAmount, 60);
  assert.equal(after1.pendingRefundAmount, 0);
  assert.equal(after1.paymentStatus, 'partially_refunded');
  assert.equal(await Refund.countDocuments({ order: order._id }), 1);
  assert.equal((await Refund.findOne({ tagadaRefundId: 'rf_conf_1' }).lean()).status, 'succeeded');

  // Dashboard-initiated refund for the remainder is recorded once.
  const rest = (n: number) => ({
    type: 'payment/refunded',
    data: { cartToken: String(order._id), status: 'refunded', n, transactions: [
      { id: 'rf_conf_1', type: 'refund', status: 'succeeded', amount: 6000 },
      { id: 'rf_dash_2', type: 'refund', status: 'succeeded', amount: 4000 },
    ] },
  });
  await sendWebhook(rest(1));
  await sendWebhook(rest(2));
  const after2 = await Order.findById(order._id).lean();
  assert.equal(after2.refundedAmount, 100);
  assert.equal(after2.paymentStatus, 'refunded');
  assert.equal(await Refund.countDocuments({ order: order._id }), 2);
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
