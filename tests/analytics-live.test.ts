import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveStatus, ACTIVE_WINDOW_MS, SESSION_TIMEOUT_MS } from '../src/services/analytics/config';
import { visitorCard, visitorSummary, activityItem, anonymousId } from '../src/services/analytics/live/cards';
import { validateCollectBatch } from '../src/services/analytics/collect';

const NOW = Date.parse('2026-11-17T01:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);

test('liveStatus: active only while recently active and not left', () => {
  assert.equal(ACTIVE_WINDOW_MS, 75_000, 'default active window');
  assert.equal(liveStatus({ lastActivityAt: ago(10_000) }, NOW), 'active');
  assert.equal(liveStatus({ lastActivityAt: ago(ACTIVE_WINDOW_MS) }, NOW), 'active', 'boundary is inclusive');
  assert.equal(liveStatus({ lastActivityAt: ago(ACTIVE_WINDOW_MS + 1) }, NOW), 'inactive', 'missed heartbeats → inactive');
  // Closed / hid the tab after their last activity → inactive at once
  assert.equal(liveStatus({ lastActivityAt: ago(5_000), leftAt: ago(2_000) }, NOW), 'inactive');
  assert.equal(liveStatus({ lastActivityAt: ago(5_000), leftAt: ago(5_000) }, NOW), 'inactive', 'left at the same moment');
  // Came back: activity newer than the leave signal → active again
  assert.equal(liveStatus({ lastActivityAt: ago(1_000), leftAt: ago(20_000) }, NOW), 'active');
  // The 30-minute session timeout decides when the visit ends, not who is online
  assert.equal(liveStatus({ lastActivityAt: ago(20 * 60_000) }, NOW), 'inactive');
  assert.equal(liveStatus({ lastActivityAt: ago(SESSION_TIMEOUT_MS + 1) }, NOW), 'ended');
  assert.equal(liveStatus({}, NOW), 'ended');
});

test('collect: "left" heartbeat is read, never assumed', () => {
  const base = { visitorId: 'visitor-abc12345', sessionId: 'session-abc12345' };
  assert.equal(validateCollectBatch({ ...base, ping: true }).left, false);
  assert.equal(validateCollectBatch({ ...base, ping: true, left: true }).left, true);
  assert.equal(validateCollectBatch({ ...base, ping: true, left: 'yes' }).left, false, 'only boolean true counts');
});

test('cards: identity, location and anonymous ID', () => {
  assert.equal(anonymousId('3f9k2a7b-1c2d-4e5f'), '#3F9K2A');
  const anon = visitorSummary({ sessionId: 's1', visitorId: 'ab12cd34-ee', geo: { country: 'Australia', countryCode: 'AU', city: 'Sydney', region: 'New South Wales', method: 'ip' } });
  assert.equal(anon.name, undefined);
  assert.equal(anon.identified, false);
  assert.equal(anon.anonymousId, '#AB12CD');
  assert.deepEqual(anon.location, { country: 'Australia', countryCode: 'AU', region: 'New South Wales', city: 'Sydney', method: 'ip' });
  // Browser timezone fallback has no ISO code: the flag still works
  assert.equal(visitorSummary({ sessionId: 's2', visitorId: 'x', geo: { country: 'New Zealand', countryCode: '', method: 'browser' } }).location?.countryCode, 'NZ');
  assert.equal(visitorSummary({ sessionId: 's3', visitorId: 'x', geo: { country: 'Unknown' } }).location, null);
  // Named only when they typed it in checkout / an order linked it
  const named = visitorSummary({ sessionId: 's4', visitorId: 'x', identity: { name: 'John Smith', email: 'j@example.com' } });
  assert.equal(named.name, 'John Smith');
  assert.equal(named.identified, true);
  assert.equal(visitorSummary({ sessionId: 's5', visitorId: 'x', identity: { email: 'j@example.com' } }).name, 'j@example.com');
  assert.equal(visitorSummary({ sessionId: 's6', visitorId: 'x' }).isNewVisitor, null, 'unknown stays unknown');
});

test('cards: card agrees with the session record and its live status', () => {
  const card = visitorCard({
    sessionId: 's1', visitorId: 'v1', startedAt: ago(12 * 60_000), lastActivityAt: ago(12_000), isNewVisitor: true,
    landingPage: '/products/retatrutide-10mg',
    source: { source: 'Google', channel: 'organic_search' },
    device: { type: 'desktop', label: 'Desktop', os: 'macOS', browser: 'Safari' },
    lastEvent: { type: 'add_to_cart', productName: 'Retatrutide 10mg', path: '/products/retatrutide-10mg', quantity: 1, at: ago(12_000) },
    counts: { pageViews: 4, productViews: 2, addToCart: 1, cartUpdates: 1 },
    cart: { itemCount: 1, value: 229 },
    checkout: { stage: 'shipping' },
    orderIds: [],
  }, NOW);
  assert.equal(card.status, 'active');
  assert.equal(card.isNewVisitor, true);
  assert.equal(card.lastEvent?.type, 'add_to_cart');
  assert.equal(card.lastEvent?.productName, 'Retatrutide 10mg');
  assert.deepEqual(card.cart, { itemCount: 1, value: 229, items: [], updatedAt: undefined });
  assert.equal(card.checkoutStage, 'shipping');
  assert.equal(card.source?.channel, 'organic_search');
  assert.equal(card.orderCount, 0);
});

test('activity item: recorded fields only, stable id and paging cursor', () => {
  const ts = new Date('2026-11-17T00:59:00Z');
  const item = activityItem(
    { _id: '6735a1b2c3d4e5f601234567', eventId: 'evt-123456789', eventType: 'product_view', timestamp: ts, path: '/products/x', productName: 'X', sessionId: 's1' },
    null
  );
  assert.equal(item.id, 'evt-123456789');
  assert.equal(item.cursor, `${ts.getTime()}_6735a1b2c3d4e5f601234567`);
  assert.equal(item.type, 'product_view');
  assert.equal(item.stage, undefined, 'nothing inferred');
  const paid = activityItem({ eventId: 'purchase:o1', eventType: 'purchase', timestamp: ts, cartValue: 229, orderId: 'o1', sessionId: 's1' }, null, { orderNumber: '1042' });
  assert.equal(paid.orderNumber, '1042');
  assert.equal(paid.value, 229);
  assert.equal(paid.cursor, undefined, 'stream items (not yet read back) have no cursor');
});
