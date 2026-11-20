import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './helpers/setup';
import axios from 'axios';
import {
  starshipitService, starshipitOrderHasLabel, detailsFromLabelResponse, labelWarning,
} from '../src/services/shipping/starshipit.service';
import { shouldRetry } from '../src/services/shipping/starshipitHttp';

/**
 * Buying a Starshipit label costs money every time POST /orders/shipment is called, so:
 * one purchase at most, never when a label exists, never retried on an unclear answer.
 * Starshipit is fully mocked (axios.get / axios.post) — nothing leaves the machine.
 */

type Call = { method: 'get' | 'post'; url: string; params?: any; body?: any };
let calls: Call[];
let restores: Array<() => void>;
const purchases = () => calls.filter((c) => c.method === 'post' && c.url.endsWith('/orders/shipment')).length;
const imports = () => calls.filter((c) => c.method === 'post' && c.url.endsWith('/orders')).length;
const httpError = (status?: number, code?: string, data?: any) =>
  Object.assign(new Error(status ? `HTTP ${status}` : code || 'error'), status ? { response: { status, data: data || {}, headers: {} } } : { code });

/** Fake Starshipit: `orders` = what GET /orders returns by order_id; handlers override behaviour. */
function mock(opts: {
  get?: (params: any) => any;
  post?: (url: string, body: any) => any;
}) {
  restores.push(stub(axios as any, 'get', async (url: string, config: any) => {
    calls.push({ method: 'get', url, params: config?.params });
    return opts.get ? opts.get(config?.params) : { status: 200, data: {} };
  }));
  restores.push(stub(axios as any, 'post', async (url: string, body: any) => {
    calls.push({ method: 'post', url, body });
    if (!opts.post) throw new Error('unexpected POST ' + url);
    return opts.post(url, body);
  }));
}

beforeEach(() => { calls = []; restores = []; });
afterEach(() => { restores.reverse().forEach((r) => r()); });

const unshipped = { order_id: 111, order_number: 'SLT1', status: 'Unshipped' };
const printed = { order_id: 111, order_number: 'SLT1', status: 'Printed', tracking_number: 'TRK-OLD', carrier: 'MyPost Business' };

// ── retry policy ──
test('label purchase is only retried on 429 — never on timeout, network error or 5xx', () => {
  for (const err of [httpError(undefined, 'ECONNABORTED'), httpError(undefined, 'ETIMEDOUT'), httpError(500), httpError(502), httpError(503), httpError(504)]) {
    assert.equal(shouldRetry(err, false, true), false, String(err.message));
  }
  assert.equal(shouldRetry(httpError(429), false, true), true);
  // reads are still retried
  assert.equal(shouldRetry(httpError(504), true), true);
});

// ── "has a label" detection ──
test('label detection: tracking / label / Printed-like status count; Unshipped does not', () => {
  assert.equal(starshipitOrderHasLabel(printed), true);
  assert.equal(starshipitOrderHasLabel({ status: 'Shipped' }), true);
  assert.equal(starshipitOrderHasLabel({ status: 'Manifested' }), true);
  assert.equal(starshipitOrderHasLabel({ status: 'Unshipped' }), false); // contains "shipped" — must not match
  assert.equal(starshipitOrderHasLabel({ status: 'New' }), false);
  assert.equal(starshipitOrderHasLabel({ status: 'Unshipped', packages: [{ tracking_number: 'X1' }] }), true);
  assert.equal(starshipitOrderHasLabel(null), false);
});

test('label reply parsing: tracking_numbers list and carrier_name shape', () => {
  const d = detailsFromLabelResponse({ success: true, order_id: 111, carrier_name: 'MyPost Business', tracking_numbers: ['TRK1'], labels: ['JVBERi0x'] });
  assert.equal(d.trackingNumber, 'TRK1');
  assert.equal(d.trackingCarrier, 'MyPost Business');
  const o = detailsFromLabelResponse({ success: true, order: { tracking_number: 'TRK2', carrier: 'AusPost', label_url: 'https://l/x.pdf' } });
  assert.deepEqual([o.trackingNumber, o.labelUrl], ['TRK2', 'https://l/x.pdf']);
});

// ── purchaseLabel ──
test('Starshipit already has a label → nothing bought, existing tracking returned', async () => {
  mock({ get: () => ({ status: 200, data: { order: printed } }) });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(out.kind, 'existing');
  assert.equal(purchases(), 0);
  assert.equal((out as any).details.trackingNumber, 'TRK-OLD');
  assert.equal(labelWarning(out), undefined);
});

test('no label yet → bought exactly once', async () => {
  mock({
    get: () => ({ status: 200, data: { order: unshipped } }),
    post: () => ({ status: 200, data: { success: true, tracking_numbers: ['TRK-NEW'], carrier_name: 'MyPost Business', label_url: 'https://l/new.pdf' } }),
  });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(out.kind, 'purchased');
  assert.equal(purchases(), 1);
  assert.equal((out as any).details.trackingNumber, 'TRK-NEW');
});

test('purchase times out but the label was made → found by re-check, NOT bought again', async () => {
  let bought = false;
  mock({
    get: () => ({ status: 200, data: { order: bought ? { ...printed, tracking_number: 'TRK-T' } : unshipped } }),
    post: () => { bought = true; throw httpError(undefined, 'ECONNABORTED'); },
  });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(purchases(), 1);
  assert.equal(out.kind, 'purchased');
  assert.equal((out as any).details.trackingNumber, 'TRK-T');
});

test('purchase times out and nothing visible yet → unconfirmed, still only one purchase', async () => {
  mock({
    get: () => ({ status: 200, data: { order: unshipped } }),
    post: () => { throw httpError(504); },
  });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(out.kind, 'unconfirmed');
  assert.equal(purchases(), 1);
  assert.match(labelWarning(out) || '', /NOT retried/);
});

test('Starshipit rejects the purchase (validation) → failed, one call, no retry', async () => {
  mock({
    get: () => ({ status: 200, data: { order: unshipped } }),
    post: () => ({ status: 200, data: { success: false, errors: [{ message: 'Invalid postcode' }] } }),
  });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(out.kind, 'failed');
  assert.equal(purchases(), 1);
  assert.match((out as any).error, /Invalid postcode/);
});

test('Starshipit can\'t be read before buying → nothing bought', async () => {
  mock({ get: () => { throw httpError(undefined, 'ECONNRESET'); }, post: () => ({ status: 200, data: { success: true } }) });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(out.kind, 'precheck_failed');
  assert.equal(purchases(), 0);
});

test('Starshipit returns a different order than asked → treated as unknown, nothing bought', async () => {
  mock({ get: () => ({ status: 200, data: { order: { order_id: 999, status: 'Unshipped' } } }), post: () => ({ status: 200, data: { success: true } }) });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(out.kind, 'precheck_failed');
  assert.equal(purchases(), 0);
});

// ── createShipment: reuse an order an earlier timed-out attempt created ──
const fakeOrder: any = {
  _id: 'o1', orderNumber: 'SLT1', shippingMethodName: 'Australia Post Express Shipping',
  shippingAddressObj: { name: 'A', street1: '1 St', city: 'Town', state: 'QLD', zip: '4000', country: 'AU' },
  customer: { email: 'a@invalid.localhost' }, lineItems: [{ title: 'X', quantity: 1, unitPrice: 10 }],
};
const pkgChoice: any = { pkg: { name: 'Mailer', dimensions: { length: 20, width: 30, height: 3 }, weightGrams: 10 }, reason: 'test', warnings: [] };
const weight: any = { itemsGrams: 10, lines: [{ description: 'X', sku: 'X', quantity: 1, unitGrams: 10, value: 10 }], warnings: [] };

test('order already in Starshipit from an earlier attempt → reused (no duplicate import), label bought once', async () => {
  mock({
    get: (p) => ({ status: 200, data: { order: p.order_number ? { ...unshipped } : unshipped } }),
    post: () => ({ status: 200, data: { success: true, tracking_numbers: ['TRK-R'] } }),
  });
  const r = await starshipitService.createShipment({ order: fakeOrder, origin: {}, weightKg: 0.01, weight, packageChoice: pkgChoice });
  assert.equal(r.orderId, '111');
  assert.equal(imports(), 0);
  assert.equal(purchases(), 1);
  assert.equal(r.trackingNumber, 'TRK-R');
});

test('earlier attempt already bought the label → reused, nothing bought', async () => {
  mock({ get: () => ({ status: 200, data: { order: printed } }) });
  const r = await starshipitService.createShipment({ order: fakeOrder, origin: {}, weightKg: 0.01, weight, packageChoice: pkgChoice });
  assert.equal(r.outcome, 'existing');
  assert.equal(imports(), 0);
  assert.equal(purchases(), 0);
  assert.equal(r.trackingNumber, 'TRK-OLD');
});

test('new order: imported once, then label bought once', async () => {
  let created = false;
  mock({
    get: (p) => (p.order_number ? (created ? { status: 200, data: { order: unshipped } } : Promise.reject(httpError(404))) : { status: 200, data: { order: unshipped } }),
    post: (url) => {
      if (url.endsWith('/orders')) { created = true; return { status: 200, data: { success: true, order: unshipped } }; }
      return { status: 200, data: { success: true, tracking_numbers: ['TRK-N'] } };
    },
  });
  const r = await starshipitService.createShipment({ order: fakeOrder, origin: {}, weightKg: 0.01, weight, packageChoice: pkgChoice });
  assert.equal(imports(), 1);
  assert.equal(purchases(), 1);
  assert.equal(r.trackingNumber, 'TRK-N');
});

test('import times out but Starshipit created it → recovered by order number, not imported twice', async () => {
  let created = false;
  mock({
    get: (p) => (p.order_number && !created ? Promise.reject(httpError(404)) : { status: 200, data: { order: unshipped } }),
    post: (url) => {
      if (url.endsWith('/orders')) { created = true; throw httpError(undefined, 'ECONNABORTED'); }
      return { status: 200, data: { success: true, tracking_numbers: ['TRK-X'] } };
    },
  });
  const r = await starshipitService.createShipment({ order: fakeOrder, origin: {}, weightKg: 0.01, weight, packageChoice: pkgChoice });
  assert.equal(imports(), 1);
  assert.equal(purchases(), 1);
  assert.equal(r.orderId, '111');
});

test('Starshipit unreachable when checking for an earlier attempt → nothing created or bought', async () => {
  mock({ get: () => { throw httpError(undefined, 'ECONNRESET'); }, post: () => ({ status: 200, data: { success: true } }) });
  await assert.rejects(
    starshipitService.createShipment({ order: fakeOrder, origin: {}, weightKg: 0.01, weight, packageChoice: pkgChoice }),
    /Nothing was created or charged/
  );
  assert.equal(imports(), 0);
  assert.equal(purchases(), 0);
});

// ── archived orders (label voided in Starshipit) ──
test('archived Starshipit order → nothing bought, voided tracking not returned', async () => {
  mock({ get: () => ({ status: 200, data: { order: { order_id: 111, order_number: 'SLT1', status: 'Archived', tracking_number: 'VOID1' } } }), post: () => ({ status: 200, data: { success: true } }) });
  const out = await starshipitService.purchaseLabel('111');
  assert.equal(out.kind, 'failed');
  assert.equal(purchases(), 0);
  const d = await starshipitService.readDetails('111');
  assert.equal(d?.archived, true);
  assert.equal(d?.trackingNumber, '');
});

test('archived match by order number is not reused → a fresh Starshipit order is created', async () => {
  let created = false;
  mock({
    get: (p) => (p.order_number
      ? { status: 200, data: { order: { order_id: 50, order_number: 'SLT1', status: 'Archived', tracking_number: 'VOID1' } } }
      : { status: 200, data: { order: { ...unshipped, order_id: 111 } } }),
    post: (url) => {
      if (url.endsWith('/orders')) { created = true; return { status: 200, data: { success: true, order: { order_id: 111, order_number: 'SLT1' } } }; }
      return { status: 200, data: { success: true, tracking_numbers: ['TRK-F'] } };
    },
  });
  const r = await starshipitService.createShipment({ order: fakeOrder, origin: {}, weightKg: 0.01, weight, packageChoice: pkgChoice });
  assert.equal(created, true);
  assert.equal(r.orderId, '111');
  assert.equal(purchases(), 1);
});
