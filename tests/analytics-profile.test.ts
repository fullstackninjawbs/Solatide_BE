import './helpers/setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitOutcome, visitRow, checkoutView, orderView } from '../src/services/analytics/live/profile';
import { cartLines, cartOf } from '../src/services/analytics/live/cards';
import { CHECKOUT_ABANDON_MS } from '../src/services/analytics/config';

const NOW = Date.parse('2026-11-20T01:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);

test('visit outcome: ordered > checkout > cart > browsed', () => {
  assert.equal(visitOutcome({ orderIds: ['a'], checkout: { checkoutId: 'c' }, counts: { addToCart: 2 } }), 'ordered');
  assert.equal(visitOutcome({ orderIds: [], checkout: { checkoutId: 'c' } }), 'checkout');
  assert.equal(visitOutcome({ counts: { addToCart: 1 } }), 'cart');
  assert.equal(visitOutcome({ cart: { itemCount: 1 } }), 'cart', 'cart restored from an earlier visit');
  assert.equal(visitOutcome({ counts: { pageViews: 9 } }), 'browsed');
  assert.equal(visitOutcome({}), 'browsed');
});

test('visit row: recorded facts only, order numbers, latest flag', () => {
  const row = visitRow(
    {
      sessionId: 's-old', visitorId: 'v1', startedAt: ago(3 * 3_600_000), lastActivityAt: ago(3 * 3_600_000 - 125_000),
      landingPage: '/products/x', source: { source: 'Google', channel: 'organic_search' },
      device: { type: 'mobile', label: 'Mobile', browser: 'Safari' },
      counts: { pageViews: 5, productViews: 2, addToCart: 1 }, cart: { itemCount: 2, value: 120 },
      checkout: { checkoutId: 'c1', stage: 'payment' }, orderIds: ['o1'],
    },
    new Map([['o1', 'SLT1001']]),
    's-new'
  );
  assert.equal(row.durationSeconds, 125);
  assert.deepEqual(row.orders, [{ id: 'o1', orderNumber: 'SLT1001' }]);
  assert.equal(row.outcome, 'ordered');
  assert.equal(row.isLatest, false);
  assert.deepEqual(row.cart, { itemCount: 2, value: 120 });
  assert.equal(row.checkoutStage, 'payment');
  assert.equal(visitRow({ sessionId: 's-new', visitorId: 'v1' }, new Map(), 's-new').isLatest, true);
  assert.equal(visitRow({ sessionId: 's', visitorId: 'v1', cart: { itemCount: 0, value: 0 } }, new Map()).cart, null, 'empty cart → none');
});

test('checkout view: submitted never abandoned; abandoned only after the timeout', () => {
  assert.equal(checkoutView(null), null);
  const base = { checkoutId: 'c1', stage: 'shipping', startedAt: ago(60 * 60_000) };
  assert.equal(checkoutView({ ...base, status: 'in_progress', lastActivityAt: ago(60_000) }, NOW)?.status, 'in_progress');
  assert.equal(checkoutView({ ...base, status: 'in_progress', lastActivityAt: ago(CHECKOUT_ABANDON_MS + 1) }, NOW)?.status, 'abandoned');
  assert.equal(checkoutView({ ...base, status: 'order_submitted', lastActivityAt: ago(CHECKOUT_ABANDON_MS * 10) }, NOW)?.status, 'order_submitted');
  assert.equal(checkoutView({ checkoutId: 'c2', status: 'in_progress', lastActivityAt: ago(0) }, NOW)?.stage, 'started');
});

test('order view: total from grandTotal, else totalAmount', () => {
  assert.equal(orderView({ _id: 'a', grandTotal: 210, totalAmount: 200 }).total, 210);
  assert.equal(orderView({ _id: 'b', totalAmount: 200 }).total, 200);
  assert.equal(orderView({ _id: 'c' }).total, undefined);
  assert.equal(orderView({ _id: 'c' }).currency, 'AUD');
});

test('cart lines: as reported, line totals rounded, capped', () => {
  const lines = cartLines([{ name: 'BPC-157', variantTitle: '10mg', quantity: 3, unitPrice: 33.33, image: '/i.png' }, { name: 'No price' }]);
  assert.equal(lines[0].lineTotal, 99.99);
  assert.equal(lines[1].quantity, 1);
  assert.equal(lines[1].lineTotal, undefined);
  assert.equal(cartLines(Array.from({ length: 50 }, () => ({ name: 'x', quantity: 1 }))).length, 30);
  assert.deepEqual(cartLines(undefined), []);
  assert.equal(cartOf(null), null);
  assert.equal(cartOf({ itemCount: 1, value: 10, items: [{ name: 'a', quantity: 1, unitPrice: 10 }] })?.items.length, 1);
});
