import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildPurchaseEvent, buildRelayedEvent, contentIdFor, metaContents, normCountry, normPhone, orderUserData, purchaseEventId,
} from '../src/domain/metaCapi';

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const NOW = Date.UTC(2026, 9, 21, 10, 0, 0);
const ORIGINS = ['https://solatidebiosciences.com.au', 'http://localhost:5173'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36';

const order = {
  _id: '6a3e54e3bab68c18b1cb3e44',
  orderNumber: 'SLT1234567B',
  paidAt: new Date(NOW - 60_000),
  grandTotal: 179.9,
  currency: 'AUD',
  customer: { firstName: ' Jane ', lastName: "O'Brien", email: ' Jane.Doe@Example.COM ', phone: '0412 345 678' },
  shippingAddressObj: { name: 'Jane OBrien', city: 'North Sydney', state: 'NSW', zip: '2060', country: 'AU' },
  products: [
    { product: '6a3e54e3bab68c18b1cb0001', sku: 'SOL-RET-010', quantity: 2, price: 79.95 },
    { product: '6a3e54e3bab68c18b1cb0002', sku: '', quantity: 1, price: 20 },
  ],
  visitor: { ip: '203.0.113.7', userAgent: UA, fbp: 'fb.1.1760000000000.1234567890', fbc: '' },
  attribution: { lastTouch: { fbclid: 'IwAR0abcDEF123', capturedAt: new Date(NOW - 3600_000) } },
};

test('content_id: variant/product SKU, else product id (same rule as the Pixel)', () => {
  assert.equal(contentIdFor({ sku: ' SOL-RET-010 ', productId: 'x' }), 'SOL-RET-010');
  assert.equal(contentIdFor({ sku: '', productId: '6a3e' }), '6a3e');
  assert.deepEqual(metaContents(order), [
    { id: 'SOL-RET-010', quantity: 2, item_price: 79.95 },
    { id: '6a3e54e3bab68c18b1cb0002', quantity: 1, item_price: 20 },
  ]);
});

test('normalisation follows Meta rules', () => {
  assert.equal(normPhone('0412 345 678'), '61412345678');
  assert.equal(normPhone('+61 412 345 678'), '61412345678');
  assert.equal(normPhone('123'), '');
  assert.equal(normCountry('Australia'), 'au');
  assert.equal(normCountry('AU'), 'au');
});

test('user_data: PII hashed (SHA-256, normalised), browser context unhashed, fbc built from fbclid', () => {
  const u = orderUserData(order);
  assert.deepEqual(u.em, [sha('jane.doe@example.com')]);
  assert.deepEqual(u.ph, [sha('61412345678')]);
  assert.deepEqual(u.fn, [sha('jane')]);
  assert.deepEqual(u.ln, [sha('obrien')]);
  assert.deepEqual(u.ct, [sha('northsydney')]);
  assert.deepEqual(u.st, [sha('nsw')]);
  assert.deepEqual(u.zp, [sha('2060')]);
  assert.deepEqual(u.country, [sha('au')]);
  assert.equal(u.client_ip_address, '203.0.113.7');
  assert.equal(u.client_user_agent, UA);
  assert.equal(u.fbp, 'fb.1.1760000000000.1234567890');
  assert.match(u.fbc!, /^fb\.1\.\d{13}\.IwAR0abcDEF123$/);
  // nothing raw leaks
  assert.ok(!JSON.stringify(u).includes('Jane') && !JSON.stringify(u).includes('0412'));
});

test('Purchase: event_id purchase_<orderId>, AUD, value, contents, website source', () => {
  const e = buildPurchaseEvent(order, { siteUrl: 'https://solatidebiosciences.com.au/', now: NOW })!;
  assert.equal(e.event_name, 'Purchase');
  assert.equal(e.event_id, purchaseEventId(order._id));
  assert.equal(e.event_id, 'purchase_6a3e54e3bab68c18b1cb3e44');
  assert.equal(e.action_source, 'website');
  assert.equal(e.event_source_url, 'https://solatidebiosciences.com.au/checkout/success');
  assert.equal(e.event_time, Math.floor((NOW - 60_000) / 1000));
  assert.deepEqual(e.custom_data, {
    currency: 'AUD', value: 179.9, content_type: 'product', content_ids: ['SOL-RET-010', '6a3e54e3bab68c18b1cb0002'],
    contents: [{ id: 'SOL-RET-010', quantity: 2, item_price: 79.95 }, { id: '6a3e54e3bab68c18b1cb0002', quantity: 1, item_price: 20 }],
    num_items: 3, order_id: 'SLT1234567B',
  });
});

test('Purchase older than 7 days (e.g. a very late retry) is not sent', () => {
  assert.equal(buildPurchaseEvent({ ...order, paidAt: new Date(NOW - 8 * 864e5) }, { siteUrl: 'https://x.au', now: NOW }), null);
});

test('relay: valid AddToCart → CAPI event with request IP/UA, AUD forced, data bounded', () => {
  const r = buildRelayedEvent({
    event_name: 'AddToCart', event_id: 'atc_0b6f3a8e-1c2d', event_source_url: 'https://solatidebiosciences.com.au/products/x#reviews',
    fbp: 'fb.1.1760000000000.1234567890', fbc: 'bad',
    custom_data: { currency: 'USD', value: '159.9', content_ids: ['SOL-RET-010'], contents: [{ id: 'SOL-RET-010', quantity: 2, item_price: 79.95 }], content_name: 'Retatrutide', evil: 'x' },
  }, { ip: '::ffff:203.0.113.7', userAgent: UA, allowedOrigins: ORIGINS, now: NOW });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.event.event_source_url, 'https://solatidebiosciences.com.au/products/x');
  assert.equal(r.event.user_data.client_ip_address, '203.0.113.7');
  assert.equal(r.event.user_data.fbp, 'fb.1.1760000000000.1234567890');
  assert.equal(r.event.user_data.fbc, undefined);
  assert.deepEqual(r.event.custom_data, {
    currency: 'AUD', value: 159.9, content_type: 'product', content_ids: ['SOL-RET-010'],
    contents: [{ id: 'SOL-RET-010', quantity: 2, item_price: 79.95 }], content_name: 'Retatrutide',
  });
});

test('relay rejects Purchase, unknown events, foreign pages, bad event ids, missing UA', () => {
  const base = { event_id: 'pv_0b6f3a8e-1c2d', event_source_url: 'https://solatidebiosciences.com.au/' };
  const ctx = { ip: '1.2.3.4', userAgent: UA, allowedOrigins: ORIGINS, now: NOW };
  assert.equal(buildRelayedEvent({ ...base, event_name: 'Purchase' }, ctx).ok, false);
  assert.equal(buildRelayedEvent({ ...base, event_name: 'Lead' }, ctx).ok, false);
  assert.equal(buildRelayedEvent({ ...base, event_name: 'PageView', event_source_url: 'https://evil.example/' }, ctx).ok, false);
  assert.equal(buildRelayedEvent({ ...base, event_name: 'PageView', event_id: 'x' }, ctx).ok, false);
  assert.equal(buildRelayedEvent({ ...base, event_name: 'PageView' }, { ...ctx, userAgent: '' }).ok, false);
  const pv = buildRelayedEvent({ ...base, event_name: 'PageView', custom_data: { value: 5 } }, ctx);
  assert.ok(pv.ok && !pv.event.custom_data, 'PageView carries no custom data');
});
