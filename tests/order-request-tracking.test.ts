import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stub, fakeQuery, OID } from './helpers/setup';
import AnalyticsEvent from '../src/models/analyticsEvent.model';
import { AnalyticsSession, AnalyticsVisitor, CheckoutSession } from '../src/models/analyticsSession.model';
import { recordOrderRequestEvent, visitorFromRequest, linkOrderToRequestVisit } from '../src/services/analytics/serverEvents';
import { visitOutcome, visitRow, checkoutView } from '../src/services/analytics/live/profile';

/**
 * Order Request checkout (the live checkout mode): a sent request is recorded on the customer's
 * visit, closes the checkout attempt as submitted (never abandoned), names the visit, and the order
 * the admin later creates joins that visit. MongoDB is stubbed.
 */

let restores: Array<() => void>;
beforeEach(() => { restores = []; });
afterEach(() => { restores.reverse().forEach((r) => r()); });

const request = {
  _id: OID(7),
  requestNumber: 'REQ-5AC85W',
  total: 54.95,
  customer: { firstName: 'Olive', lastName: 'Request', email: 'Olive@Example.com' },
  shippingAddress: { country: 'AU' },
  visitor: { sessionId: 'session-abcdef12', visitorId: 'visitor-abcdef12', checkoutId: 'checkout-abcdef12' },
};

function stubAll(calls: any[], opts: { sessionVisitor?: string; createError?: any } = {}) {
  restores.push(stub(AnalyticsSession as any, 'findOne', () => fakeQuery({ visitorId: opts.sessionVisitor ?? 'visitor-abcdef12', geo: { country: 'Australia', region: 'Victoria', city: 'Melbourne' } })));
  restores.push(stub(AnalyticsEvent as any, 'create', async (doc: any) => {
    if (opts.createError) throw opts.createError;
    calls.push({ m: 'event', doc });
    return { toObject: () => doc };
  }));
  restores.push(stub(CheckoutSession as any, 'updateOne', (f: any, u: any, o: any) => { calls.push({ m: 'checkout', f, u, o }); return fakeQuery({ matchedCount: 1 }); }));
  restores.push(stub(AnalyticsSession as any, 'updateOne', (f: any, u: any) => { calls.push({ m: 'session', f, u }); return fakeQuery({ matchedCount: 1 }); }));
  restores.push(stub(AnalyticsVisitor as any, 'updateOne', (f: any, u: any) => { calls.push({ m: 'visitor', f, u }); return fakeQuery({ matchedCount: 1 }); }));
}

test('order request sent: event recorded once, checkout closed as submitted, visit named, cart emptied', async () => {
  const calls: any[] = [];
  stubAll(calls);
  assert.equal(await recordOrderRequestEvent(request), true);

  const ev = calls.find((c) => c.m === 'event').doc;
  assert.equal(ev.eventId, `order_request:${request._id}`, 'one event per request (retries never double count)');
  assert.equal(ev.eventType, 'order_request');
  assert.equal(ev.requestNumber, 'REQ-5AC85W');
  assert.equal(ev.clientReported, false);
  assert.equal(ev.cartValue, 54.95);
  assert.equal(ev.country, 'Australia', 'location from the visit (IP), never the shipping address');

  const [closeCheckout, minStage] = calls.filter((c) => c.m === 'checkout');
  assert.equal(closeCheckout.f.checkoutId, 'checkout-abcdef12');
  assert.equal(closeCheckout.f.visitorId, 'visitor-abcdef12', 'only this visitor\'s attempt');
  assert.equal(closeCheckout.u.$set.status, 'order_submitted', 'a sent request is never an abandoned checkout');
  assert.equal(closeCheckout.u.$set.requestNumber, 'REQ-5AC85W');
  assert.equal(closeCheckout.u.$set['contact.email'], 'olive@example.com');
  assert.equal(closeCheckout.o.upsert, true, 'created as submitted if the browser\'s first checkout event is still on its way');
  assert.deepEqual(minStage.u.$set.stage, 'shipping');

  const s = calls.find((c) => c.m === 'session');
  assert.equal(s.f.sessionId, 'session-abcdef12');
  assert.equal(s.u.$set['identity.name'], 'Olive Request');
  assert.equal(s.u.$set['identity.email'], 'olive@example.com');
  assert.equal(s.u.$set.lastEvent.type, 'order_request');
  assert.equal(s.u.$set.cart.itemCount, 0);
  assert.deepEqual(s.u.$addToSet, { requestNumbers: 'REQ-5AC85W' });
  assert.equal(s.u.$addToSet.orderIds, undefined, 'no order exists yet: orders are not counted');

  const v = calls.find((c) => c.m === 'visitor');
  assert.equal(v.f.visitorId, 'visitor-abcdef12');
  assert.equal(v.u.$set['identity.name'], 'Olive Request');
});

test('order request: no visit IDs, a visit owned by another visitor, or a repeat -> nothing linked', async () => {
  const calls: any[] = [];
  stubAll(calls, { sessionVisitor: 'someone-else-99' });
  assert.equal(await recordOrderRequestEvent({ ...request, visitor: undefined }), false);
  assert.equal(await recordOrderRequestEvent(request), false, 'never linked to another visitor\'s visit');
  assert.equal(calls.length, 0);

  restores.reverse().forEach((r) => r()); restores = [];
  const calls2: any[] = [];
  stubAll(calls2, { createError: Object.assign(new Error('dup'), { code: 11000 }) });
  assert.equal(await recordOrderRequestEvent(request), false, 'already recorded');
  assert.equal(calls2.filter((c) => c.m !== 'event').length, 0, 'a repeat changes nothing');
});

test('order created from a request carries the request\'s visitor IDs and joins that visit', async () => {
  assert.deepEqual(visitorFromRequest(request), { sessionId: 'session-abcdef12', visitorId: 'visitor-abcdef12', checkoutId: 'checkout-abcdef12', country: undefined });
  assert.equal(visitorFromRequest({ visitor: { sessionId: 'bad id!' } }), undefined, 'malformed IDs are dropped');

  const calls: any[] = [];
  restores.push(stub(AnalyticsSession as any, 'updateOne', (f: any, u: any) => { calls.push({ m: 'session', f, u }); return fakeQuery({}); }));
  restores.push(stub(CheckoutSession as any, 'updateOne', (f: any, u: any) => { calls.push({ m: 'checkout', f, u }); return fakeQuery({}); }));
  const order = { _id: OID(9) };
  await linkOrderToRequestVisit(order, request);
  assert.deepEqual(calls.find((c) => c.m === 'session').u, { $addToSet: { orderIds: order._id } });
  const c = calls.find((x) => x.m === 'checkout');
  assert.equal(String(c.f.orderRequestId), String(request._id), 'only the attempt submitted as this request');
  assert.equal(c.u.$set.orderId, order._id);
});

test('visitor panel: a visit that sent a request shows "Order request sent" with its reference', () => {
  assert.equal(visitOutcome({ requestNumbers: ['REQ-1'], checkout: { checkoutId: 'c' } }), 'requested');
  assert.equal(visitOutcome({ orderIds: ['o'], requestNumbers: ['REQ-1'] }), 'ordered', 'an order created from it wins');
  const row = visitRow({ sessionId: 's', requestNumbers: ['REQ-1'], counts: {} }, new Map());
  assert.deepEqual(row.requestNumbers, ['REQ-1']);
  const cv = checkoutView({ checkoutId: 'c', status: 'order_submitted', lastActivityAt: new Date(0), requestNumber: 'REQ-1' });
  assert.equal(cv?.status, 'order_submitted', 'never "abandoned", however long ago');
  assert.equal(cv?.requestNumber, 'REQ-1');
});
