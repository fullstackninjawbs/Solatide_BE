import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDiscount, cleanRules, displayStatus, type CartLine } from '../src/domain/discountEngine';

const PEPTIDE = '64b000000000000000000001';
const PEPTIDE2 = '64b000000000000000000004';
const BAC_WATER = '64b000000000000000000002';
const SYRINGES = '64b000000000000000000003';
const line = (productId: string, quantity: number, price: number): CartLine => ({ productId, quantity, price });
const base = { code: 'X', status: 'active', type: 'percent', value: 15, maxUses: 0, usesSoFar: 0, perCustomerLimit: 0 };

test('discount: no rules → percent off the items subtotal (shipping never discounted)', () => {
  const r = computeDiscount(base, [line(PEPTIDE, 2, 100)]);
  assert.deepEqual(r.ok && { amount: r.amount, label: r.label }, { amount: 30, label: '15% off' });
  const f = computeDiscount({ ...base, type: 'fixed', value: 500 }, [line(PEPTIDE, 1, 80)]);
  assert.equal(f.ok && f.amount, 80, 'fixed amount never more than the items');
});

test('discount: 15WHOLE26A — min 5 items, Bac Water + syringes do not count', () => {
  const d = { ...base, ruleMatch: 'all', rules: [{ type: 'cart_min_quantity', quantity: 5, products: [BAC_WATER, SYRINGES] }] } as any;
  const short = computeDiscount(d, [line(PEPTIDE, 3, 100), line(BAC_WATER, 5, 10)]);
  assert.equal(short.ok, false);
  assert.match(!short.ok ? short.reason : '', /at least 5 eligible items/);
  const ok = computeDiscount(d, [line(PEPTIDE, 5, 100), line(BAC_WATER, 2, 10)]);
  assert.equal(ok.ok && ok.amount, 78, '15% of the whole order (500 + 20)');
});

test('discount: excluded products are never discounted', () => {
  const d = { ...base, value: 10, rules: [{ type: 'excluded_products', products: [BAC_WATER] }] } as any;
  const r = computeDiscount(d, [line(PEPTIDE, 1, 100), line(BAC_WATER, 1, 20)]);
  assert.equal(r.ok && r.amount, 10);
  assert.equal(computeDiscount(d, [line(BAC_WATER, 3, 20)]).ok, false, 'only excluded items → not applicable');
});

test('discount: totals, contains product, max quantity; AND vs OR', () => {
  const rules = [{ type: 'cart_total_min', amount: 200 }, { type: 'cart_contains_product', products: [PEPTIDE2] }];
  const cart = [line(PEPTIDE, 3, 100)]; // 300, no PEPTIDE2
  assert.equal(computeDiscount({ ...base, ruleMatch: 'all', rules } as any, cart).ok, false);
  assert.equal(computeDiscount({ ...base, ruleMatch: 'any', rules } as any, cart).ok, true);
  assert.equal(computeDiscount({ ...base, rules: [{ type: 'cart_total_max', amount: 250 }] } as any, cart).ok, false);
  assert.equal(computeDiscount({ ...base, rules: [{ type: 'max_product_quantity', quantity: 2 }] } as any, cart).ok, false);
  assert.equal(computeDiscount({ ...base, rules: [{ type: 'max_product_quantity', quantity: 3 }] } as any, cart).ok, true);
});

test('discount: usage limit, one per customer, dates, disabled', () => {
  const cart = [line(PEPTIDE, 1, 100)];
  assert.match((computeDiscount({ ...base, maxUses: 1, usesSoFar: 1 }, cart) as any).reason, /usage limit/);
  assert.match((computeDiscount({ ...base, perCustomerLimit: 1 }, cart, { customerUses: 1 }) as any).reason, /already used/);
  assert.equal(computeDiscount({ ...base, perCustomerLimit: 1 }, cart, { customerUses: 0 }).ok, true);
  assert.match((computeDiscount({ ...base, activeFrom: new Date(Date.now() + 86400000) }, cart) as any).reason, /isn't active yet/);
  assert.match((computeDiscount({ ...base, activeTo: new Date(Date.now() - 1000) }, cart) as any).reason, /expired/);
  assert.equal(computeDiscount({ ...base, status: 'disabled' }, cart).ok, false);
  assert.equal(computeDiscount(null, cart).ok, false);
});

test('discount: legacy minPurchase / minQuantity still apply', () => {
  assert.equal(computeDiscount({ ...base, minPurchase: 500 }, [line(PEPTIDE, 1, 100)]).ok, false);
  assert.equal(computeDiscount({ ...base, minQuantity: 2 }, [line(PEPTIDE, 2, 100)]).ok, true);
});

test('discount rules validation + display status', () => {
  assert.deepEqual(cleanRules([{ type: 'cart_min_quantity', quantity: 5, products: [BAC_WATER, BAC_WATER] }]).rules, [{ type: 'cart_min_quantity', quantity: 5, products: [BAC_WATER] }]);
  assert.ok(cleanRules([{ type: 'nope' }]).errors.length);
  assert.ok(cleanRules([{ type: 'cart_contains_product', products: [] }]).errors.length);
  assert.ok(cleanRules([{ type: 'cart_min_quantity', quantity: 0 }]).errors.length);
  assert.ok(cleanRules([{ type: 'excluded_products', products: ['not-an-id'] }]).errors.length);
  assert.equal(displayStatus({ code: 'A', status: 'active', activeFrom: new Date(Date.now() + 86400000) }), 'scheduled');
  assert.equal(displayStatus({ code: 'A', status: 'active', maxUses: 1, usesSoFar: 1 }), 'expired');
  assert.equal(displayStatus({ code: 'A', status: 'disabled' }), 'disabled');
  assert.equal(displayStatus({ code: 'A', status: 'active' }), 'active');
});
