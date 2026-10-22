/**
 * Pure-function tests for payment/order remediation (no DB, no network).
 * Run: npx ts-node --transpile-only tests/payments/unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  canTransitionPayment, planPaymentTransition, mapTagadaStatus, PAYMENT_STATUSES, PaymentStatus,
  isFulfilmentAdvanced, paidStatusSideFields, allowedPredecessors,
} from '../../src/domain/orderTransitions';
import { toMinorUnits, fromMinorUnits, validateRefundRequest, refundsEnabled, hasAtMostTwoDecimals } from '../../src/domain/money';
import {
  verifyTagadaSignature, deriveWebhookEventId, buildOrderLookupPlan, resolveSingleCandidate, isUsableExternalId,
} from '../../src/domain/tagadaWebhook';
import { checkDiscountEligibility, pickDiscountFields } from '../../src/domain/discountEligibility';
import { escapeRegExp } from '../../src/domain/escapeRegExp';
import { accessTokenMatches, generateOrderAccessToken } from '../../src/domain/orderAccess';
import { buildRevenueMatch, netRevenueExpr } from '../../src/domain/revenue';
import { resolveCheckoutLines, parseQuantity } from '../../src/services/orders/checkoutItems';
import { extractProviderRefunds, extractRefundId, refundTargetStatus } from '../../src/services/orders/refunds';
import { extractCouponCode } from '../../src/services/orders/tagadaOrderMapper';

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

test('mapTagadaStatus: partially_refunded goes to the refund branch, not paid', () => {
  assert.equal(mapTagadaStatus('partially_refunded'), 'partially_refunded');
  assert.equal(mapTagadaStatus('partially_refunded', 'payment/refunded'), 'partially_refunded');
  assert.equal(mapTagadaStatus('refunded', 'payment/refunded'), 'refunded');
  assert.equal(mapTagadaStatus('captured'), 'paid');
  assert.equal(mapTagadaStatus('whatever', 'order/paid'), 'paid');
  assert.equal(mapTagadaStatus('declined'), 'failed');
  assert.equal(mapTagadaStatus('voided'), 'cancelled');
  assert.equal(mapTagadaStatus('', 'payment/failed'), 'failed');
  assert.equal(mapTagadaStatus('mystery'), null);
});

// ─── Money / refunds ─────────────────────────────────────────────────────────
test('unit conversion helpers', () => {
  assert.equal(toMinorUnits(49.99), 4999);
  assert.equal(toMinorUnits(0.1 + 0.2), 30);
  assert.equal(fromMinorUnits(4999), 49.99);
  assert.equal(fromMinorUnits('1050'), 10.5);
  assert.equal(fromMinorUnits(undefined), 0);
  assert.throws(() => toMinorUnits(NaN));
  assert.equal(hasAtMostTwoDecimals(10.25), true);
  assert.equal(hasAtMostTwoDecimals(10.255), false);
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

test('REFUNDS_ENABLED flag', () => {
  assert.equal(refundsEnabled({} as any, 'sandbox'), true);
  assert.equal(refundsEnabled({} as any, 'production'), false);
  assert.equal(refundsEnabled({ REFUNDS_ENABLED: 'true' } as any, 'production'), true);
  assert.equal(refundsEnabled({ REFUNDS_ENABLED: 'false' } as any, 'sandbox'), false);
});

test('provider refund extraction uses minor units and never double counts', () => {
  const r = extractProviderRefunds({
    amount: 10000,
    transactions: [
      { id: 'tx_cap', type: 'capture', status: 'succeeded', amount: 10000 },
      { id: 'tx_r1', type: 'refund', status: 'succeeded', amount: 2500 },
      { id: 'tx_r2', type: 'refund', status: 'failed', amount: 9999 },
    ],
  });
  assert.deepEqual(r, { txns: [{ id: 'tx_r1', amount: 25 }], total: 25 });
  assert.deepEqual(extractProviderRefunds({ refundedAmount: 1234 }), { txns: [], total: 12.34 });
  assert.deepEqual(extractProviderRefunds({ amount: 10000 }), { txns: [], total: null }); // payment amount is NOT a refund amount
  assert.equal(extractRefundId({ refund: { id: 'rf_1' } }), 'rf_1');
  assert.equal(extractRefundId({ id: 'unknown' }), null);
  assert.equal(extractRefundId(undefined), null);
  assert.equal(refundTargetStatus({ grandTotal: 100, refundedAmount: 100 }), 'refunded');
  assert.equal(refundTargetStatus({ grandTotal: 100, refundedAmount: 40 }), 'partially_refunded');
});

// ─── Webhook signature ───────────────────────────────────────────────────────
test('signature verification: valid / invalid / length mismatch / malformed', () => {
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify({ type: 'order/paid', data: { id: 'x' } }));
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyTagadaSignature(body, `sha256=${hex}`, secret), true);
  assert.equal(verifyTagadaSignature(body, hex, secret), true);
  assert.equal(verifyTagadaSignature(body, `sha256=${hex.toUpperCase()}`, secret), true);
  assert.equal(verifyTagadaSignature(body, `sha256=${'0'.repeat(64)}`, secret), false);
  assert.equal(verifyTagadaSignature(body, `sha256=${hex.slice(0, 10)}`, secret), false); // length mismatch, no throw
  assert.equal(verifyTagadaSignature(body, `sha256=${hex}00`, secret), false);
  assert.equal(verifyTagadaSignature(body, 'sha256=not-hex!', secret), false);
  assert.equal(verifyTagadaSignature(body, undefined, secret), false);
  assert.equal(verifyTagadaSignature(body, `sha256=${hex}`, ''), false);
  assert.equal(verifyTagadaSignature(Buffer.from('tampered'), `sha256=${hex}`, secret), false);
});

// ─── Event id ────────────────────────────────────────────────────────────────
test('event id derivation', () => {
  const body = Buffer.from('{"type":"payment/succeeded","data":{"id":"pay_1"}}');
  const a = deriveWebhookEventId(body, {}, JSON.parse(body.toString()));
  const b = deriveWebhookEventId(Buffer.from(body), {}, JSON.parse(body.toString()));
  assert.equal(a.source, 'body_sha256');
  assert.equal(a.eventId, b.eventId);
  assert.match(a.eventId, /^sha256:[0-9a-f]{64}$/);
  // Same payment id, different event → different id (payload.id is NOT used)
  const c = deriveWebhookEventId(Buffer.from('{"type":"payment/refunded","data":{"id":"pay_1"}}'), {}, {});
  assert.notEqual(c.eventId, a.eventId);
  assert.deepEqual(deriveWebhookEventId(body, { 'x-tagadapay-event-id': 'evt_9' }, {}), { eventId: 'evt_9', source: 'header' });
  assert.deepEqual(deriveWebhookEventId(body, {}, { eventId: 'evt_p' }), { eventId: 'evt_p', source: 'payload' });
});

// ─── Order lookup plan ───────────────────────────────────────────────────────
function assertNoUndefined(clauses: Array<Record<string, unknown>>) {
  for (const c of clauses) {
    for (const [k, v] of Object.entries(c)) {
      assert.equal(typeof v, 'string', `clause ${k} must be a string`);
      assert.notEqual(String(v).toLowerCase(), 'unknown');
      assert.ok(String(v).length > 0);
    }
  }
}

test('lookup plan prefers our own ObjectId', () => {
  const id = '65a1b2c3d4e5f6a7b8c9d0e1';
  const p = buildOrderLookupPlan({ data: { cartToken: id, checkoutSessionId: 'cs_1', orderId: undefined } });
  assert.equal(p.kind, 'byId');
  if (p.kind === 'byId') {
    assert.equal(p.orderId, id);
    assertNoUndefined(p.fallbackClauses);
    assert.ok(!p.fallbackClauses.some((c) => 'tagadaOrderId' in c));
  }
});

test('lookup plan never builds undefined or unknown clauses', () => {
  const p = buildOrderLookupPlan({ data: { checkoutSessionId: 'unknown', paymentId: '', orderId: undefined, session_id: null } });
  assert.equal(p.kind, 'none');
  const q = buildOrderLookupPlan({ data: { checkoutSessionId: 'cs_abc', orderId: 'ord_1', paymentId: 'unknown' } });
  assert.equal(q.kind, 'byExternal');
  if (q.kind === 'byExternal') {
    assertNoUndefined(q.clauses);
    assert.deepEqual(q.clauses, [
      { tagadaPaymentId: 'cs_abc' }, { tagadaSessionId: 'cs_abc' }, { tagadaOrderId: 'ord_1' },
    ]);
  }
});

test('lookup plan: conflicting own ids → conflict; ambiguous matches refused', () => {
  const p = buildOrderLookupPlan({ data: { cartToken: '65a1b2c3d4e5f6a7b8c9d0e1', externalOrderId: '65a1b2c3d4e5f6a7b8c9d0e2' } });
  assert.equal(p.kind, 'conflict');
  assert.deepEqual(resolveSingleCandidate([{ _id: 'a' }, { _id: 'b' }]), { kind: 'ambiguous', ids: ['a', 'b'] });
  assert.deepEqual(resolveSingleCandidate([{ _id: 'a' }, { _id: 'a' }]), { kind: 'found', order: { _id: 'a' } });
  assert.deepEqual(resolveSingleCandidate([]), { kind: 'none' });
  assert.equal(isUsableExternalId('unknown'), false);
  assert.equal(isUsableExternalId('  '), false);
  assert.equal(isUsableExternalId(undefined), false);
  assert.equal(isUsableExternalId('cs_1'), true);
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
  const { data, errors } = pickDiscountFields({ code: 'SAVE10', type: 'percent', value: 10, usesSoFar: 0, tagadaPromotionId: 'x', isAdmin: true }, { partial: false });
  assert.deepEqual(errors, []);
  assert.equal('usesSoFar' in data, false);
  assert.equal('tagadaPromotionId' in data, false);
  assert.equal('isAdmin' in data, false);
  assert.ok(pickDiscountFields({ code: 'bad code!', value: 1 }, { partial: false }).errors.length > 0);
  assert.ok(pickDiscountFields({ code: 'X', type: 'percent', value: 150 }, { partial: false }).errors.length > 0);
  assert.ok(pickDiscountFields({ value: 5 }, { partial: false }).errors.includes('code is required'));
});

test('coupon code extraction never uses the description text', () => {
  assert.equal(extractCouponCode({}, { adjustments: [{ type: 'Promotion', description: '10% off everything' }] }), undefined);
  assert.equal(extractCouponCode({}, { adjustments: [{ description: 'x', promotionCode: { code: 'SAVE10' } }] }), 'SAVE10');
  assert.equal(extractCouponCode({ discount_codes: [{ code: 'WELCOME' }] }, {}), 'WELCOME');
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
  _id: PID, name: 'BPC-157', price: 99, publishStatus: 'active', tagadaVariantId: 'tv_base',
  variants: [
    { _id: 'v5mg00000000000000000001', title: '5mg', price: 50, stockQty: 3, inventoryPolicy: 'deny', tagadaVariantId: 'tv_5', sku: 'B5' },
    { _id: 'v10mg0000000000000000002', title: '10mg', price: 80, stockQty: 0, inventoryPolicy: 'continue', tagadaVariantId: 'tv_10', sku: 'B10' },
  ],
};
const loader = async (id: string) => (id === PID ? product : null);

test('checkout resolves the selected variant price server-side', async () => {
  const [l] = await resolveCheckoutLines([{ productId: PID, variantId: 'v5mg00000000000000000001', quantity: 2 }], loader);
  assert.equal(l.price, 50);
  assert.equal(l.tagadaVariantId, 'tv_5');
  assert.equal(String(l.variant), 'v5mg00000000000000000001');
  const [byTagada] = await resolveCheckoutLines([{ productId: PID, tagadaVariantId: 'tv_10', quantity: 5 }], loader);
  assert.equal(byTagada.price, 80); // continue policy: no stock check
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
