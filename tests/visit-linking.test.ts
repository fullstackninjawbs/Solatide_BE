import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stub, fakeQuery, OID } from './helpers/setup';
import { AnalyticsSession, AnalyticsVisitor } from '../src/models/analyticsSession.model';
import { parseUserAgent } from '../src/services/analytics/device';
import { emailLink } from '../src/services/emailLinks';
import { linkVisitByOrderAccess } from '../src/services/analytics/serverEvents';

/**
 * Same customer, two browsers: Google app label, email link UTM tags, and naming a visit that opened
 * an order's payment link (valid token). MongoDB is stubbed.
 */

let restores: Array<() => void>;
beforeEach(() => { restores = []; });
afterEach(() => { restores.reverse().forEach((r) => r()); });

const GSA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/448.4.1021463781 Mobile/15E148 Safari/604.1';
const CRIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/158.0.8127.35 Mobile/15E148 Safari/604.1';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

test('browser: Google app in-app browser is "Google app" (not Safari); Chrome and Safari unchanged', () => {
  assert.equal(parseUserAgent(GSA).browser, 'Google app');
  assert.equal(parseUserAgent(CRIOS).browser, 'Chrome');
  assert.equal(parseUserAgent(SAFARI).browser, 'Safari');
  assert.equal(parseUserAgent(GSA).label, 'iPhone');
});

test('email links: UTM tags added, existing accessToken kept; bad URL unchanged', () => {
  const u = new URL(emailLink('https://shop.example/checkout/payment/abc?accessToken=t0k', 'payment_details'));
  assert.equal(u.searchParams.get('accessToken'), 't0k');
  assert.equal(u.searchParams.get('utm_source'), 'solatide');
  assert.equal(u.searchParams.get('utm_medium'), 'email');
  assert.equal(u.searchParams.get('utm_campaign'), 'payment_details');
  assert.equal(emailLink('not a url', 'shipping'), 'not a url');
});

const order = { _id: OID(1), customer: { firstName: 'Ricky', lastName: 'Salter', email: 'Ricky@Example.com' }, visitor: { sessionId: 'placing-session-1' } };

test('payment link opened in another browser: that visit and visitor get the customer name/email (only if they have none)', async () => {
  const calls: any[] = [];
  restores.push(stub(AnalyticsSession as any, 'updateOne', (f: any, u: any) => { calls.push({ m: 'session', f, u }); return fakeQuery({ matchedCount: 1, modifiedCount: 1 }); }));
  restores.push(stub(AnalyticsVisitor as any, 'updateOne', (f: any, u: any) => { calls.push({ m: 'visitor', f, u }); return fakeQuery({ matchedCount: 1, modifiedCount: 1 }); }));
  await linkVisitByOrderAccess(order, { sessionId: 'chrome-session-12', visitorId: 'chrome-visitor-34' });
  const s = calls.find((c) => c.m === 'session');
  const v = calls.find((c) => c.m === 'visitor');
  assert.equal(s.f.sessionId, 'chrome-session-12');
  assert.deepEqual(s.f['identity.name'], { $in: [null, ''] }, 'never overwrites an existing identity');
  assert.equal(s.u.$set['identity.name'], 'Ricky Salter');
  assert.equal(s.u.$set['identity.email'], 'ricky@example.com');
  assert.equal(s.u.$set['identity.linkedBy'], 'order_link');
  assert.equal(s.u.$addToSet, undefined, 'the order is not added to that visit (no double counting)');
  assert.equal(v.f.visitorId, 'chrome-visitor-34');
});

test('payment link: same browser that placed the order, invalid ids, or no customer details -> nothing written', async () => {
  let writes = 0;
  restores.push(stub(AnalyticsSession as any, 'updateOne', () => { writes++; return fakeQuery({ matchedCount: 1 }); }));
  restores.push(stub(AnalyticsVisitor as any, 'updateOne', () => { writes++; return fakeQuery({ matchedCount: 1 }); }));
  await linkVisitByOrderAccess(order, { sessionId: 'placing-session-1' });
  await linkVisitByOrderAccess(order, { sessionId: 'bad id!', visitorId: '<script>' });
  await linkVisitByOrderAccess({ _id: OID(2), customer: {} }, { sessionId: 'chrome-session-12' });
  assert.equal(writes, 0);
});

test('payment link: visit not stored yet -> retried later (not lost)', async () => {
  const timers: number[] = [];
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = (fn: any, ms: number) => { timers.push(ms); return { unref() {} }; };
  restores.push(() => { (global as any).setTimeout = realSetTimeout; });
  restores.push(stub(AnalyticsSession as any, 'updateOne', () => fakeQuery({ matchedCount: 0, modifiedCount: 0 })));
  restores.push(stub(AnalyticsSession as any, 'exists', async () => null));
  await linkVisitByOrderAccess(order, { sessionId: 'chrome-session-12' });
  assert.deepEqual(timers, [3000]);
});
