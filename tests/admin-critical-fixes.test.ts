import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stub, fakeQuery, OID } from './helpers/setup';
import Order from '../src/models/order.model';
import Product from '../src/models/product.model';
import Batch from '../src/models/batch.model';
import Customer from '../src/models/Customer';
import { validateRefundRequest } from '../src/domain/money';
import { updateOrder } from '../src/controllers/admin/orderController';
import { applyStockBaseline } from '../src/controllers/product.controller';
import { createBatch, updateBatch } from '../src/controllers/batch.controller';
import { sanitizeQuestions } from '../src/controllers/admin/contentController';
import { isBannedCustomerEmail } from '../src/services/checkout/bannedCustomer';

/**
 * Admin bug fixes (fix/admin-critical-bugs): refund payload, order contact edit, stock baseline,
 * current batch, FAQ visibility, banned customers. MongoDB is stubbed.
 */

let restores: Array<() => void>;
beforeEach(() => { restores = []; });
afterEach(() => { restores.reverse().forEach((r) => r()); });

/** Run a catchAsync controller; resolves with { status, body, error }. */
const run = (handler: any, req: any) => new Promise<{ status?: number; body?: any; error?: any }>((resolve) => {
  const res: any = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  handler(req, res, (error: any) => resolve({ error }));
});

// ── 1. Refund ──
test('refund: the payload the admin now sends (full: true) is accepted; the old { type: "full" } was rejected', () => {
  const ok = validateRefundRequest({ full: true, grandTotal: 120, refundedAmount: 0 } as any);
  assert.equal(ok.ok, true);
  assert.equal((ok as any).amount, 120);
  const old = validateRefundRequest({ type: 'full', grandTotal: 120, refundedAmount: 0 } as any);
  assert.equal(old.ok, false);
});

// ── 2. Order contact edit ──
test('order contact edit: name, email (lowercased), phone are saved; customerEmail/customerName kept in sync', async () => {
  let update: any;
  restores.push(stub(Order as any, 'findByIdAndUpdate', (_id: any, u: any) => { update = u; return fakeQuery({ _id: OID(1) }); }));
  const r = await run(updateOrder, {
    params: { id: OID(1) },
    body: { customer: { firstName: ' Jane ', lastName: 'Doe', email: ' Jane.Doe@Example.COM ', phone: '0400 000 000' }, customerEmail: 'ignored@x.com' },
  });
  assert.equal(r.error, undefined);
  assert.equal(update.$set['customer.email'], 'jane.doe@example.com');
  assert.equal(update.$set.customerEmail, 'jane.doe@example.com');
  assert.equal(update.$set['customer.firstName'], 'Jane');
  assert.equal(update.$set['customer.lastName'], 'Doe');
  assert.equal(update.$set['customer.phone'], '0400 000 000');
  assert.equal(update.$set.customerName, 'Jane Doe');
});

test('order contact edit: an invalid email is refused (nothing saved)', async () => {
  let called = false;
  restores.push(stub(Order as any, 'findByIdAndUpdate', () => { called = true; return fakeQuery(null); }));
  const r = await run(updateOrder, { params: { id: OID(1) }, body: { customer: { firstName: 'A', email: 'not-an-email' } } });
  assert.equal(r.error?.statusCode, 400);
  assert.equal(called, false);
});

test('order update without customer: unchanged (tags only)', async () => {
  let update: any;
  restores.push(stub(Order as any, 'findByIdAndUpdate', (_id: any, u: any) => { update = u; return fakeQuery({ _id: OID(1) }); }));
  await run(updateOrder, { params: { id: OID(1) }, body: { tags: ['vip'] } });
  assert.deepEqual(update.$set, { tags: ['vip'] });
});

// ── 3. Stock baseline ──
const V1 = OID(11), V2 = OID(12);
const stubProduct = (doc: any) => restores.push(stub(Product as any, 'findById', () => fakeQuery(doc)));

test('stock: product saved without touching stock keeps the CURRENT stock (orders since page load are not undone)', async () => {
  // Page loaded 10 / 4; meanwhile an order took 3 from variant 1 → DB has 7 / 4
  stubProduct({ _id: OID(1), stockQuantity: 11, variants: [{ _id: V1, stockQty: 7 }, { _id: V2, stockQty: 4 }] });
  const data: any = { stockQuantity: 14, variants: [{ _id: V1, stockQty: 14 }, { _id: V2, stockQty: 4 }] };
  await applyStockBaseline(OID(1), data, { stockQuantity: 14, variants: { [V1]: 14, [V2]: 4 } });
  assert.equal(data.variants[0].stockQty, 7);
  assert.equal(data.variants[1].stockQty, 4);
  assert.equal(data.stockQuantity, 11);
});

test('stock: an admin change is applied as a difference to the current stock (10 -> 60 = +50)', async () => {
  stubProduct({ _id: OID(1), stockQuantity: 7, variants: [{ _id: V1, stockQty: 7 }] });
  const data: any = { stockQuantity: 60, variants: [{ _id: V1, stockQty: 60 }] };
  await applyStockBaseline(OID(1), data, { stockQuantity: 10, variants: { [V1]: 10 } });
  assert.equal(data.variants[0].stockQty, 57);
  assert.equal(data.stockQuantity, 57);
});

test('stock: never below 0; new variants (no _id / no baseline) keep the value sent', async () => {
  stubProduct({ _id: OID(1), stockQuantity: 2, variants: [{ _id: V1, stockQty: 2 }] });
  const data: any = { variants: [{ _id: V1, stockQty: 5 }, { title: 'New', stockQty: 9 }] };
  await applyStockBaseline(OID(1), data, { stockQuantity: 10, variants: { [V1]: 10 } });
  assert.equal(data.variants[0].stockQty, 0);
  assert.equal(data.variants[1].stockQty, 9);
  assert.equal(data.stockQuantity, 9);
});

test('stock: Inventory "Add" (root baseline only) adds to the current first-variant stock', async () => {
  // List showed 10, admin adds 5 → sends 15; DB now 8
  stubProduct({ _id: OID(1), stockQuantity: 8, variants: [{ _id: V1, stockQty: 8 }] });
  const data: any = { stockQuantity: 15, variants: [{ _id: V1, stockQty: 15 }] };
  await applyStockBaseline(OID(1), data, { stockQuantity: 10 });
  assert.equal(data.variants[0].stockQty, 13);
  assert.equal(data.stockQuantity, 13);
});

test('stock: product without variants uses the root stock difference', async () => {
  stubProduct({ _id: OID(1), stockQuantity: 4, variants: [] });
  const data: any = { stockQuantity: 10 };
  await applyStockBaseline(OID(1), data, { stockQuantity: 10 });
  assert.equal(data.stockQuantity, 4);
});

// ── 4. Current batch ──
const batchDoc = (over: any = {}) => ({ _id: OID(50), products: [OID(1)], variantId: null, status: 'active', ...over });
const stubBatchProducts = () => {
  const saves: any[] = [];
  restores.push(stub(Product as any, 'findById', () => {
    const doc: any = { _id: OID(1), slug: 'p', id: 1, variants: [{ _id: V1, currentBatchId: OID(49) }], markModified() {}, async save() { saves.push(this.variants[0].currentBatchId); } };
    const q: any = fakeQuery(doc);
    q.then = (res: any, rej: any) => Promise.resolve(doc).then(res, rej);
    return q;
  }));
  return saves;
};

test('batch: editing a batch (or removing its COA) does NOT make it current', async () => {
  const saves = stubBatchProducts();
  restores.push(stub(Batch as any, 'findByIdAndUpdate', async () => batchDoc()));
  const r = await run(updateBatch, { params: { id: OID(50) }, body: { notes: 'fixed typo', coaUrl: '' } });
  assert.equal(r.status, 200);
  assert.equal(saves.length, 0);
});

test('batch: editing with "Make this the current batch" ticked makes it current', async () => {
  const saves = stubBatchProducts();
  restores.push(stub(Batch as any, 'findByIdAndUpdate', async () => batchDoc()));
  await run(updateBatch, { params: { id: OID(50) }, body: { setAsCurrent: true } });
  assert.equal(saves.length, 1);
  assert.equal(String(saves[0]), OID(50));
});

test('batch: an inactive batch is never made current, even when asked', async () => {
  const saves = stubBatchProducts();
  restores.push(stub(Batch as any, 'findByIdAndUpdate', async () => batchDoc({ status: 'inactive' })));
  await run(updateBatch, { params: { id: OID(50) }, body: { setAsCurrent: true, status: 'inactive' } });
  assert.equal(saves.length, 0);
});

test('batch: a new batch becomes current by default (unchanged), but not when unticked', async () => {
  let saves = stubBatchProducts();
  restores.push(stub(Batch as any, 'create', async () => batchDoc()));
  await run(createBatch, { body: { productId: OID(1), products: [OID(1)], batchId: 'B-1', setAsCurrent: true } });
  assert.equal(saves.length, 1);
  restores.reverse().forEach((r) => r()); restores = [];
  saves = stubBatchProducts();
  restores.push(stub(Batch as any, 'create', async () => batchDoc()));
  await run(createBatch, { body: { productId: OID(1), products: [OID(1)], batchId: 'B-2', setAsCurrent: false } });
  assert.equal(saves.length, 0);
});

// ── 5. FAQ visibility ──
test('FAQ: hidden questions stay hidden and keep their order after saving', () => {
  const out = sanitizeQuestions([
    { _id: OID(1), question: 'Q1', answer: '<p>A</p>', isVisible: false, sortOrder: 3 },
    { question: 'Q2', answer: 'B' },
  ]);
  assert.equal(out[0].isVisible, false);
  assert.equal(out[0].sortOrder, 3);
  assert.equal(out[1].isVisible, true);
  assert.equal(out[1].sortOrder, 1);
});

// ── 10. Banned customers ──
test('banned customer: matched case-insensitively; not banned / lookup error never blocks', async () => {
  let filter: any;
  restores.push(stub(Customer as any, 'exists', async (f: any) => { filter = f; return f.email === 'bad@example.com' ? { _id: OID(9) } : null; }));
  assert.equal(await isBannedCustomerEmail(' Bad@Example.com '), true);
  assert.deepEqual(filter, { email: 'bad@example.com', banned: true });
  assert.equal(await isBannedCustomerEmail('good@example.com'), false);
  assert.equal(await isBannedCustomerEmail(''), false);
  restores.reverse().forEach((r) => r()); restores = [];
  restores.push(stub(Customer as any, 'exists', async () => { throw new Error('db down'); }));
  assert.equal(await isBannedCustomerEmail('bad@example.com'), false);
});
