import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageFromStatus, applyTrackingStage, deliverySummary } from '../src/services/shipping/deliveryStatus';

test('stageFromStatus: Starshipit order + carrier statuses', () => {
  assert.equal(stageFromStatus('Order Created in Starshipit (Label Pending)'), 'label_pending');
  assert.equal(stageFromStatus('Unshipped'), 'label_pending');
  assert.equal(stageFromStatus('Label Generated'), 'label_created');
  assert.equal(stageFromStatus('Printed'), 'label_created');
  assert.equal(stageFromStatus('Dispatched'), 'in_transit');
  assert.equal(stageFromStatus('InTransit'), 'in_transit');
  assert.equal(stageFromStatus('OutForDelivery'), 'out_for_delivery');
  assert.equal(stageFromStatus('AwaitingCollection'), 'out_for_delivery');
  assert.equal(stageFromStatus('Received by Australia Post'), 'in_transit');
  assert.equal(stageFromStatus('Lodged at Post Office'), 'in_transit');
  assert.equal(stageFromStatus('Shipping information received by Australia Post'), 'label_created');
  assert.equal(stageFromStatus('Delivered'), 'delivered');
  assert.equal(stageFromStatus('AttemptedDelivery'), 'exception');
  assert.equal(stageFromStatus('Not delivered - card left'), 'exception');
  assert.equal(stageFromStatus('Returned to sender'), 'returned');
  assert.equal(stageFromStatus(''), null);
  assert.equal(stageFromStatus('something else'), null);
});

test('applyTrackingStage: forward only, fills earlier milestones, exceptions', () => {
  const d1 = new Date('2026-11-01T01:00:00Z');
  const d2 = new Date('2026-11-02T01:00:00Z');
  const d3 = new Date('2026-11-03T01:00:00Z');
  const o: any = { trackingNumber: 'AP123' };
  assert.equal(applyTrackingStage(o, 'label_created', d1), true);
  assert.equal(o.tracking.stage, 'label_created');
  assert.equal(o.deliveryStatus, 'tracking_added');
  assert.equal(applyTrackingStage(o, 'in_transit', d2), true);
  // The scheduled refresh's older status can't move it back
  assert.equal(applyTrackingStage(o, 'label_created', d3), false);
  assert.equal(o.tracking.stage, 'in_transit');
  assert.equal(o.tracking.labelCreatedAt, d1);
  assert.equal(o.tracking.inTransitAt, d2);
  // Jumping to delivered fills Out for Delivery
  assert.equal(applyTrackingStage(o, 'delivered', d3), true);
  assert.equal(o.tracking.outForDeliveryAt, d3);
  assert.equal(o.deliveryStatus, 'delivered');
  // Delivered is final
  assert.equal(applyTrackingStage(o, 'exception', d3), false);

  const e: any = {};
  applyTrackingStage(e, 'in_transit', d1);
  assert.equal(applyTrackingStage(e, 'exception', d2), true);
  assert.equal(e.tracking.stage, 'exception');
  assert.equal(applyTrackingStage(e, 'label_created', d3), false, 'an earlier stage does not clear an exception');
  assert.equal(applyTrackingStage(e, 'in_transit', d3), true, 'a new scan clears it');

  // Manual: the admin can move the status back; later milestones are forgotten
  const m: any = {};
  applyTrackingStage(m, 'delivered', d2);
  applyTrackingStage(m, 'in_transit', d3, { force: true });
  assert.equal(m.tracking.stage, 'in_transit');
  assert.equal(m.tracking.deliveredAt, undefined);
  assert.equal(m.tracking.outForDeliveryAt, undefined);
});

test('deliverySummary: list status incl. legacy orders and delays', () => {
  const now = new Date('2026-11-12T00:00:00Z');
  assert.equal(deliverySummary({}, now).stage, 'not_shipped');
  assert.equal(deliverySummary({ starshipitOrderId: '1', shipmentStatus: 'Order Created in Starshipit (Label Pending)' }, now).stage, 'label_pending');
  assert.equal(deliverySummary({ trackingNumber: 'X', shipmentStatus: 'Label Generated' }, now).stage, 'label_created');
  assert.equal(deliverySummary({ trackingNumber: 'X', shipmentStatus: 'Delivered' }, now).stage, 'delivered');
  const transit = { tracking: { stage: 'in_transit', inTransitAt: new Date('2026-11-10T00:00:00Z'), lastUpdateAt: new Date('2026-11-10T00:00:00Z') } };
  assert.equal(deliverySummary(transit, now).stage, 'in_transit');
  const stuck = { tracking: { stage: 'in_transit', inTransitAt: new Date('2026-11-04T00:00:00Z'), lastUpdateAt: new Date('2026-11-05T00:00:00Z') } };
  assert.deepEqual([deliverySummary(stuck, now).stage, deliverySummary(stuck, now).days], ['delayed', 7]);
  assert.equal(deliverySummary({ trackingNumber: 'X', trackingSource: 'manual', tracking: { stage: 'label_created' } }, now).source, 'manual');
});

test('parseCarrierTime: Starshipit local times are Sydney time, whatever the server/browser zone', async () => {
  const { parseCarrierTime } = await import('../src/services/shipping/deliveryStatus');
  // 12 Nov = daylight saving (AEDT, UTC+11): 4:43 pm Sydney = 05:43 UTC
  assert.equal(parseCarrierTime('2026-11-12T16:43:00'), '2026-11-12T05:43:00.000Z');
  assert.equal(parseCarrierTime('2026-11-12 16:43'), '2026-11-12T05:43:00.000Z');
  // July = standard time (AEST, UTC+10)
  assert.equal(parseCarrierTime('2026-07-01T09:00:00'), '2026-06-30T23:00:00.000Z');
  // An explicit offset is kept
  assert.equal(parseCarrierTime('2026-11-12T16:43:00+11:00'), '2026-11-12T05:43:00.000Z');
  assert.equal(parseCarrierTime('2026-11-12T05:43:00Z'), '2026-11-12T05:43:00.000Z');
  assert.equal(parseCarrierTime(''), '');
  assert.equal(parseCarrierTime('not a date'), '');
});
