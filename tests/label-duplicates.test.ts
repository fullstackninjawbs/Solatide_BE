import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stub, fakeQuery } from './helpers/setup';
import axios from 'axios';
import Order from '../src/models/order.model';
import * as producers from '../src/queues/producers';
import {
  isLabelExistsElsewhereError, mergeDuplicateEvidence, findShippedListDuplicates, recordLabelDuplicate,
} from '../src/services/shipping/labelDuplicates';
import { starshipitService, labelWarning, LABEL_EXISTS_ELSEWHERE_MESSAGE } from '../src/services/shipping/starshipit.service';
import { applyStarshipitTrackingUpdate } from '../src/services/shipping/starshipitTracking';

/**
 * Duplicate-label alerts: detection only. Nothing here may buy, retry or change a label, and the
 * existing tracking/webhook behaviour must stay exactly the same. Starshipit, MongoDB and email are mocked.
 */

let restores: Array<() => void>;
let mails: any[];
let updates: Array<{ filter: any; update: any }>;
beforeEach(() => {
  restores = []; mails = []; updates = [];
  restores.push(stub(producers as any, 'deliverMail', async (mail: any) => { mails.push(mail); return { queued: true }; }));
  restores.push(stub(Order as any, 'updateOne', (filter: any, update: any) => { updates.push({ filter, update }); return fakeQuery({ acknowledged: true }); }));
  restores.push(stub(Order as any, 'updateMany', (filter: any, update: any) => { updates.push({ filter, update }); return fakeQuery({ acknowledged: true }); }));
});
afterEach(() => { restores.reverse().forEach((r) => r()); });

// ── 51015 detection ──
test('51015 / "generated via a different service" is recognised; other errors are not', () => {
  assert.equal(isLabelExistsElsewhereError('MyPost Business: API errors: 51015 These labels have been generated via a different service. You are only able to reprint these labels using the same service.'), true);
  assert.equal(isLabelExistsElsewhereError('These labels have been generated via a different service.'), true);
  assert.equal(isLabelExistsElsewhereError('Invalid postcode'), false);
  assert.equal(isLabelExistsElsewhereError('order 1510155 failed'), false);
  assert.equal(isLabelExistsElsewhereError(undefined), false);
});

// ── evidence merging ──
test('new evidence is recorded once; repeats are not new; a resolved warning stays resolved for the same evidence', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  const first = mergeDuplicateEvidence(undefined, { reason: 'second_tracking', trackingNumbers: ['A', 'B', ''], starshipitOrderIds: ['1'] }, now);
  assert.equal(first.isNew, true);
  assert.deepEqual(first.next.trackingNumbers, ['A', 'B']);
  assert.deepEqual(first.next.reasons, ['second_tracking']);
  assert.equal(first.next.detectedAt, now);

  const resolved = { ...first.next, resolvedAt: now, resolvedBy: 'Gracie' };
  const repeat = mergeDuplicateEvidence(resolved, { reason: 'second_tracking', trackingNumbers: ['B', 'A'], starshipitOrderIds: ['1'] });
  assert.equal(repeat.isNew, false);
  assert.equal(repeat.next.resolvedAt, now, 'same evidence never re-opens');
  assert.equal(repeat.next.detectedAt, now);

  const third = mergeDuplicateEvidence(resolved, { reason: 'second_tracking', trackingNumbers: ['A', 'C'] });
  assert.equal(third.isNew, true);
  assert.deepEqual(third.next.trackingNumbers, ['A', 'B', 'C']);
  assert.equal(third.next.resolvedAt, undefined, 'a new tracking number re-opens it');
});

// ── daily shipped-list check ──
test("shipped list: Gracie's case (label on a second Starshipit order) is flagged", () => {
  const shipped = [
    { order_id: 785798056, order_number: 'SLT6277163B', tracking_number: '99724064932601004300906' },
    { order_id: 786169422, order_number: 'SLT3183171B', tracking_number: '99724083144101004300905' },
  ];
  const ours = new Map<string, any>([
    ['SLT6277163B', { orderNumber: 'SLT6277163B', starshipitOrderId: '785797186', trackingNumber: '99724064932601004300901', trackingSource: 'starshipit' }],
    ['SLT3183171B', { orderNumber: 'SLT3183171B', starshipitOrderId: '786169422', trackingNumber: '99724083144101004300905', trackingSource: 'starshipit' }],
  ]);
  const found = findShippedListDuplicates(shipped, ours);
  assert.deepEqual([...found.keys()], ['SLT6277163B'], 'the normal order is not flagged');
  const reasons = found.get('SLT6277163B')!.map((e) => e.reason).sort();
  assert.deepEqual(reasons, ['second_starshipit_order', 'second_tracking']);
  assert.deepEqual(found.get('SLT6277163B')![0].starshipitOrderIds!.sort(), ['785797186', '785798056']);
});

test('shipped list: normal orders, not-yet-synced orders, archived entries, manual tracking and foreign orders are not flagged', () => {
  const shipped = [
    { order_id: 1, order_number: 'N1', tracking_number: 'T1' },                       // matches ours exactly
    { order_id: 2, order_number: 'N2', tracking_number: 'T2' },                       // ours has no tracking yet
    { order_id: 3, order_number: 'N3', tracking_number: 'T3' },
    { order_id: 33, order_number: 'N3', tracking_number: 'T33', status: 'Archived' }, // voided → ignored
    { order_id: 4, order_number: 'N4', tracking_number: 'T4' },                       // ours manual, different number
    { order_id: 9, order_number: 'OTHER', tracking_number: 'T9' },
    { order_id: 99, order_number: 'OTHER', tracking_number: 'T99' },                  // not our order
  ];
  const ours = new Map<string, any>([
    ['N1', { starshipitOrderId: '1', trackingNumber: 'T1', trackingSource: 'starshipit' }],
    ['N2', { starshipitOrderId: '2' }],
    ['N3', { starshipitOrderId: '3', trackingNumber: 'T3' }],
    ['N4', { starshipitOrderId: '4', trackingNumber: 'MANUAL-1', trackingSource: 'manual' }],
  ]);
  assert.equal(findShippedListDuplicates(shipped, ours).size, 0);
});

test('shipped list: two shipped labels for one order number are flagged even before we saved anything', () => {
  const shipped = [
    { order_id: 5, order_number: 'N5', tracking_number: 'T5a' },
    { order_id: 5, order_number: 'N5', tracking_number: 'T5b' },
  ];
  const found = findShippedListDuplicates(shipped, new Map([['N5', { starshipitOrderId: '5' }]]));
  assert.deepEqual(found.get('N5')!.map((e) => e.reason), ['second_tracking']);
});

// ── recording + alert email ──
test('recordLabelDuplicate: first time saves + emails once; repeated evidence only touches lastDetectedAt (no email)', async () => {
  let stored: any = undefined;
  restores.push(stub(Order as any, 'findById', () => fakeQuery({ _id: 'o1', orderNumber: 'SLT1', labelDuplicate: stored })));

  const flagged = await recordLabelDuplicate('o1', { reason: 'second_tracking', trackingNumbers: ['A', 'B'] });
  assert.ok(flagged);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /duplicate shipping label — order #SLT1/);
  assert.match(mails[0].html, /A, B/);
  assert.ok(updates.some((u) => u.update.$set?.labelDuplicate), 'record saved');
  assert.ok(updates.some((u) => u.update.$set?.['labelDuplicate.alertedAt']), 'alert stamped');

  stored = flagged!.labelDuplicate;
  mails = []; updates = [];
  const again = await recordLabelDuplicate('o1', { reason: 'second_tracking', trackingNumbers: ['B', 'A'] });
  assert.equal(again, null);
  assert.equal(mails.length, 0);
  assert.deepEqual(Object.keys(updates[0].update.$set), ['labelDuplicate.lastDetectedAt']);
});

test('recordLabelDuplicate never throws (database error → logged, null)', async () => {
  restores.push(stub(Order as any, 'findById', () => { throw new Error('db down'); }));
  assert.equal(await recordLabelDuplicate('o1', { reason: 'second_tracking', trackingNumbers: ['A', 'B'] }), null);
});

// ── webhook: behaviour unchanged, plus the flag ──
function fakeOrder(fields: any) {
  const o: any = { _id: 'o2', orderNumber: 'SLT2', comments: [], saves: 0, ...fields };
  o.save = async () => { o.saves++; return o; };
  return o;
}

test('webhook with a DIFFERENT tracking number: order updated exactly as before AND flagged', async () => {
  restores.push(stub(Order as any, 'findById', () => fakeQuery({ _id: 'o2', orderNumber: 'SLT2' })));
  const order = fakeOrder({ status: 'shipped', fulfilmentStatus: 'fulfilled', trackingNumber: 'OLD', trackingSource: 'starshipit', shipmentStatus: 'Printed', starshipitOrderId: '111' });
  const r = await applyStarshipitTrackingUpdate(order, { tracking_number: 'NEW', tracking_status: 'Printed' });
  assert.equal(r.changed, true);
  assert.equal(order.trackingNumber, 'NEW', 'same behaviour as before: the latest number is saved');
  assert.equal(order.saves, 1);
  const rec = updates.find((u) => u.update.$set?.labelDuplicate)?.update.$set.labelDuplicate;
  assert.deepEqual(rec.trackingNumbers, ['OLD', 'NEW']);
  assert.deepEqual(rec.reasons, ['second_tracking']);
  assert.equal(mails.length, 1);
});

test('webhook with the SAME tracking number, or the first tracking number, or manual tracking: never flagged', async () => {
  restores.push(stub(Order as any, 'findById', () => { throw new Error('must not be called'); }));
  const same = fakeOrder({ status: 'shipped', fulfilmentStatus: 'fulfilled', trackingNumber: 'T1', shipmentStatus: 'Printed' });
  await applyStarshipitTrackingUpdate(same, { tracking_number: 'T1', tracking_status: 'Printed' });
  const first = fakeOrder({ status: 'shipped', fulfilmentStatus: 'fulfilled', shipmentStatus: 'Printed' });
  await applyStarshipitTrackingUpdate(first, { tracking_number: 'T1', tracking_status: 'Printed' });
  assert.equal(first.trackingNumber, 'T1');
  const manual = fakeOrder({ status: 'shipped', trackingNumber: 'M1', trackingSource: 'manual', comments: [] });
  await applyStarshipitTrackingUpdate(manual, { tracking_number: 'OTHER' });
  assert.equal(manual.trackingNumber, 'M1', 'manual tracking is still kept');
  assert.equal(updates.filter((u) => u.update.$set?.labelDuplicate).length, 0);
  assert.equal(mails.length, 0);
});

// ── purchase: 51015 → clear message, nothing retried ──
test('label refused with 51015: one request, nothing bought or retried, clear "already exists" message', async () => {
  process.env.STARSHIPIT_API_KEY = 'k'; process.env.STARSHIPIT_SUBSCRIPTION_KEY = 's';
  restores.push(() => { process.env.STARSHIPIT_API_KEY = ''; process.env.STARSHIPIT_SUBSCRIPTION_KEY = ''; });
  let posts = 0;
  restores.push(stub(axios as any, 'get', async () => ({ status: 200, data: { success: true, order: { order_id: 111, order_number: 'SLT1', status: 'Unshipped' } } })));
  restores.push(stub(axios as any, 'post', async (url: string) => {
    if (!url.endsWith('/orders/shipment')) throw new Error('unexpected POST ' + url);
    posts++;
    return { status: 200, data: { success: false, errors: [{ message: 'MyPost Business: API errors: 51015 These labels have been generated via a different service. You are only able to reprint these labels using the same service.' }] } };
  }));
  const outcome = await starshipitService.purchaseLabel('111', { orderNumber: 'SLT1' });
  assert.equal(posts, 1);
  assert.equal(outcome.kind, 'failed');
  assert.equal((outcome as any).existsElsewhere, true);
  assert.equal(labelWarning(outcome), LABEL_EXISTS_ELSEWHERE_MESSAGE);
});

test('other label refusals keep their original message (no existsElsewhere)', async () => {
  restores.push(stub(axios as any, 'get', async () => ({ status: 200, data: { success: true, order: { order_id: 111, order_number: 'SLT1', status: 'Unshipped' } } })));
  restores.push(stub(axios as any, 'post', async () => ({ status: 200, data: { success: false, errors: [{ message: 'Invalid postcode' }] } })));
  const outcome = await starshipitService.purchaseLabel('111', { orderNumber: 'SLT1' });
  assert.equal(outcome.kind, 'failed');
  assert.equal((outcome as any).existsElsewhere, undefined);
  assert.equal(labelWarning(outcome), 'Invalid postcode');
});
