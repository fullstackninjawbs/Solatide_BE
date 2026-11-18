/**
 * Pure-function tests for order payment / refund / checkout rules (no DB, no network).
 * Run: npx ts-node --transpile-only tests/payments/unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canTransitionPayment, planPaymentTransition, PAYMENT_STATUSES, PaymentStatus,
  isFulfilmentAdvanced, paidStatusSideFields, allowedPredecessors,
} from '../../src/domain/orderTransitions';
import { validateRefundRequest, hasAtMostTwoDecimals } from '../../src/domain/money';
import { checkDiscountEligibility, pickDiscountFields } from '../../src/domain/discountEligibility';
import { escapeRegExp } from '../../src/domain/escapeRegExp';
import { accessTokenMatches, generateOrderAccessToken } from '../../src/domain/orderAccess';
import { buildRevenueMatch, netRevenueExpr } from '../../src/domain/revenue';
import { resolveCheckoutLines, parseQuantity } from '../../src/services/orders/checkoutItems';
import { refundTargetStatus } from '../../src/services/orders/refunds';

// ─── Transition guard (table-driven) ─────────────────────────────────────────
test('payment transition table', () => {
  const allowed: Record<PaymentStatus, PaymentStatus[]> = {
    pending: ['paid', 'failed', 'cancelled'],
    failed: ['paid'],
    cancelled: ['paid'],
    paid: ['partially_refunded', 'refunded'],
    partially_refunded: ['partially_refunded', 'refunded'],
    refunded: [],
  };
  for (const from of PAYMENT_STATUSES) {
    for (const to of PAYMENT_STATUSES) {
      assert.equal(canTransitionPayment(from, to), allowed[from].includes(to), `${from} → ${to}`);
    }
  }
});

test('paid can never go back to pending/failed/cancelled', () => {
  for (const to of ['pending', 'failed', 'cancelled'] as PaymentStatus[]) {
    assert.equal(planPaymentTransition('paid', to).action, 'reject');
    assert.equal(planPaymentTransition('refunded', to).action, 'reject');
  }
  assert.equal(planPaymentTransition('paid', 'paid').action, 'noop');
  assert.equal(planPaymentTransition('partially_refunded', 'partially_refunded').action, 'apply');
  assert.equal(planPaymentTransition(undefined, 'paid').action, 'apply');
  assert.deepEqual(allowedPredecessors('paid').sort(), ['cancelled', 'failed', 'pending']);
});

test('repeated paid event never resets fulfilment of an advanced order', () => {
  const shipped = { status: 'shipped', fulfilmentStatus: 'fulfilled', deliveryStatus: 'in_transit' };
  assert.equal(isFulfilmentAdvanced(shipped), true);
  assert.deepEqual(paidStatusSideFields(shipped), {});
  assert.deepEqual(paidStatusSideFields({ status: 'pending' }), { status: 'processing', fulfilmentStatus: 'unfulfilled', deliveryStatus: 'pending' });
  assert.deepEqual(paidStatusSideFields({ status: 'processing', fulfilmentStatus: 'unfulfilled', deliveryStatus: 'pending' }), {});
});

test('refund validation', () => {
  const base = { grandTotal: 100, refundedAmount: 0 };
  const bad = (input: any) => {
    const r = validateRefundRequest({ ...base, ...input });
    assert.equal(r.ok, false, JSON.stringify(input));
  };
  bad({ amount: -5 });
  bad({ amount: 'abc' });
  bad({ amount: NaN });
  bad({ amount: Infinity });
  bad({ amount: 100.01 });
  bad({ amount: 10.123 });
  bad({ amount: 0 });          // 0 without full:true
  bad({});                     // absent without full:true
  bad({ amount: 60, refundedAmount: 50 }); // exceeds remaining

  const full = validateRefundRequest({ ...base, full: true });
  assert.deepEqual(full, { ok: true, amount: 100, type: 'full', remaining: 100 });
  const rem = validateRefundRequest({ grandTotal: 100, refundedAmount: 40, full: true });
  assert.ok(rem.ok && rem.amount === 60 && rem.type === 'partial');
  const part = validateRefundRequest({ ...base, amount: '25.50' });
  assert.ok(part.ok && part.amount === 25.5 && part.type === 'partial');
  const exact = validateRefundRequest({ ...base, amount: 100 });
  assert.ok(exact.ok && exact.type === 'full');
  assert.equal(validateRefundRequest({ grandTotal: 50, refundedAmount: 50, full: true }).ok, false);
});

test('refund target status', () => {
  assert.equal(refundTargetStatus({ grandTotal: 100, refundedAmount: 100 }), 'refunded');
  assert.equal(refundTargetStatus({ grandTotal: 100, refundedAmount: 40 }), 'partially_refunded');
});

// ─── Discounts ───────────────────────────────────────────────────────────────
test('discount eligibility', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  const d = { code: 'SAVE10', status: 'active', maxUses: 5, usesSoFar: 4, minPurchase: 50, perCustomerLimit: 1,
    activeFrom: new Date('2026-01-01'), activeTo: new Date('2026-12-31') };
  assert.deepEqual(checkDiscountEligibility(d, { now, subtotal: 60, customerUses: 0 }), { ok: true });
  assert.equal((checkDiscountEligibility({ ...d, usesSoFar: 5 }, { now, subtotal: 60 }) as any).code, 'max_uses');
  assert.equal((checkDiscountEligibility(d, { now, subtotal: 40 }) as any).code, 'min_purchase');
  assert.equal((checkDiscountEligibility(d, { now, subtotal: 60, customerUses: 1 }) as any).code, 'per_customer');
  assert.equal((checkDiscountEligibility({ ...d, activeTo: new Date('2026-10-01') }, { now, subtotal: 60 }) as any).code, 'expired');
  assert.equal((checkDiscountEligibility({ ...d, activeFrom: new Date('2026-11-01') }, { now, subtotal: 60 }) as any).code, 'not_started');
  assert.equal((checkDiscountEligibility({ ...d, status: 'disabled' }, { now, subtotal: 60 }) as any).code, 'inactive');
  assert.equal((checkDiscountEligibility(null, { now }) as any).code, 'not_found');
  assert.deepEqual(checkDiscountEligibility({ ...d, maxUses: 0, usesSoFar: 999 }, { now, subtotal: 60 }), { ok: true }); // 0 = unlimited
});

test('discount field whitelist blocks mass assignment', () => {
  const { data, errors } = pickDiscountFields({ code: 'SAVE10', type: 'percent', value: 10, usesSoFar: 0, isAdmin: true }, { partial: false });
  assert.deepEqual(errors, []);
  assert.equal('usesSoFar' in data, false);
  assert.equal('isAdmin' in data, false);
  assert.ok(pickDiscountFields({ code: 'bad code!', value: 1 }, { partial: false }).errors.length > 0);
  assert.ok(pickDiscountFields({ code: 'X', type: 'percent', value: 150 }, { partial: false }).errors.length > 0);
  assert.ok(pickDiscountFields({ value: 5 }, { partial: false }).errors.includes('code is required'));
});

test('escapeRegExp neutralises regex metacharacters', () => {
  const evil = '(a+)+$';
  const re = new RegExp(`^${escapeRegExp(evil)}$`);
  assert.equal(re.test(evil), true);
  assert.equal(re.test('aaaa'), false);
  assert.equal(escapeRegExp('x'.repeat(500)).length, 100);
});

test('access tokens', () => {
  const t = generateOrderAccessToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(accessTokenMatches(t, t), true);
  assert.equal(accessTokenMatches(t, t.slice(1)), false);
  assert.equal(accessTokenMatches(t, undefined), false);
  assert.equal(accessTokenMatches(undefined, t), false);
  assert.equal(accessTokenMatches(t, ['x']), false);
});

test('revenue match excludes pending & deleted, net of refunds', () => {
  const m: any = buildRevenueMatch({ createdAt: { $gte: new Date(0) } });
  assert.deepEqual(m.paymentStatus, { $in: ['paid', 'partially_refunded', 'refunded'] });
  assert.deepEqual(m.isDeleted, { $ne: true });
  assert.ok(m.createdAt);
  assert.deepEqual(netRevenueExpr.$subtract[1], { $ifNull: ['$refundedAmount', 0] });
});

// ─── Checkout lines (M-11) ───────────────────────────────────────────────────
const PID = '65a1b2c3d4e5f6a7b8c9d0e1';
const product = {
  _id: PID, name: 'BPC-157', price: 99, publishStatus: 'active',
  variants: [
    { _id: 'v5mg00000000000000000001', title: '5mg', price: 50, stockQty: 3, inventoryPolicy: 'deny', sku: 'B5' },
    { _id: 'v10mg0000000000000000002', title: '10mg', price: 80, stockQty: 0, inventoryPolicy: 'continue', sku: 'B10' },
  ],
};
const loader = async (id: string) => (id === PID ? product : null);

test('checkout resolves the selected variant price server-side', async () => {
  const [l] = await resolveCheckoutLines([{ productId: PID, variantId: 'v5mg00000000000000000001', quantity: 2 }], loader);
  assert.equal(l.price, 50);
  assert.equal(String(l.variant), 'v5mg00000000000000000001');
  assert.equal(l.sku, 'B5');
  const [l10] = await resolveCheckoutLines([{ productId: PID, variantId: 'v10mg0000000000000000002', quantity: 5 }], loader);
  assert.equal(l10.price, 80); // continue policy: no stock check
  // A product without our variant id match is refused (no external variant ids are accepted)
  await assert.rejects(resolveCheckoutLines([{ productId: PID, variantId: 'tv_10', quantity: 1 }], loader), /not found/);
});

test('checkout validation: quantity bounds, stock (deny), missing variant', async () => {
  for (const q of [0, -1, 1.5, 101, 'abc', null]) assert.throws(() => parseQuantity(q), /Quantity/);
  assert.equal(parseQuantity('3'), 3);
  await assert.rejects(resolveCheckoutLines([{ productId: PID, variantId: 'v5mg00000000000000000001', quantity: 4 }], loader), /Only 3 units/);
  await assert.rejects(resolveCheckoutLines([
    { productId: PID, variantId: 'v5mg00000000000000000001', quantity: 2 },
    { productId: PID, variantId: 'v5mg00000000000000000001', quantity: 2 },
  ], loader), /Only 3 units/);
  await assert.rejects(resolveCheckoutLines([{ productId: PID, quantity: 1 }], loader), /select a variant/);
  await assert.rejects(resolveCheckoutLines([{ productId: PID, variantId: 'nope', quantity: 1 }], loader), /not found/);
  await assert.rejects(resolveCheckoutLines([{ productId: 'not-an-id', quantity: 1 }], loader), /no longer available/);
  await assert.rejects(resolveCheckoutLines([], loader), /At least one/);
});
