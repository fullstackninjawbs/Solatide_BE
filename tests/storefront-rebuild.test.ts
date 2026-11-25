import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stub, fakeQuery, OID } from './helpers/setup';
import mongoose from 'mongoose';
import Product from '../src/models/product.model';
import * as producers from '../src/queues/producers';
import * as hooks from '../src/utils/storefrontRebuildHooks';
import { StorefrontRebuildStatus, recordRebuildFinished } from '../src/services/storefront/rebuildStatus';
import { returnStock } from '../src/services/orders/inventory';

/**
 * Storefront rebuild enhancements: failure alerts (throttled) + recovery email, and stock returns
 * that only rebuild when an item comes back in stock. MongoDB is stubbed.
 */

let restores: Array<() => void>;
let mails: any[];
let sets: any[];
let current: any;
beforeEach(() => {
  restores = []; mails = []; sets = []; current = null;
  process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@invalid.localhost';
  // Pretend the DB is connected (the status helpers skip work otherwise)
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 });
  restores.push(() => { delete (mongoose.connection as any).readyState; }); // back to the real getter
  restores.push(stub(producers as any, 'deliverMail', async (m: any) => { mails.push(m); return { queued: true }; }));
  restores.push(stub(StorefrontRebuildStatus as any, 'findOne', () => fakeQuery(current)));
  restores.push(stub(StorefrontRebuildStatus as any, 'updateOne', (_f: any, u: any) => {
    sets.push(u.$set);
    current = { ...(current || {}), ...u.$set };
    return fakeQuery({ acknowledged: true });
  }));
});
afterEach(() => { restores.reverse().forEach((r) => r()); });

test('rebuild failed: status recorded and ONE admin email; a second failure within the hour sends no email', async () => {
  current = { lastResult: 'success', lastSuccessAt: new Date('2026-11-24T00:00:00Z') };
  await recordRebuildFinished(1);
  assert.equal(current.lastResult, 'failed');
  assert.equal(current.consecutiveFailures, 1);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /website update failed/i);
  assert.ok(current.lastAlertAt);
  await recordRebuildFinished(1);
  assert.equal(current.consecutiveFailures, 2);
  assert.equal(mails.length, 1, 'throttled');
});

test('rebuild keeps failing: emailed again after an hour', async () => {
  current = { lastResult: 'failed', consecutiveFailures: 3, lastAlertAt: new Date(Date.now() - 61 * 60 * 1000) };
  await recordRebuildFinished(2);
  assert.equal(mails.length, 1);
  assert.equal(current.consecutiveFailures, 4);
});

test('rebuild recovers: success recorded, failures reset, "working again" email only if a failure was emailed', async () => {
  current = { lastResult: 'failed', consecutiveFailures: 2, lastAlertAt: new Date() };
  await recordRebuildFinished(0);
  assert.equal(current.lastResult, 'success');
  assert.equal(current.consecutiveFailures, 0);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /working again/i);
  mails = [];
  await recordRebuildFinished(0);
  assert.equal(mails.length, 0, 'normal success sends nothing');
});

test('busy exit (75) is not a failure: no email, failures unchanged', async () => {
  current = { lastResult: 'success', consecutiveFailures: 0 };
  await recordRebuildFinished(75);
  assert.equal(current.lastResult, 'busy');
  assert.equal(mails.length, 0);
});

// ── stock returns ──
const V = OID(7);
test('stock return: rebuild only when the item comes back in stock (0 -> 2), not 5 -> 7', async () => {
  const notified: unknown[] = [];
  restores.push(stub(hooks as any, 'notifyStockAvailabilityChanged', (id: unknown) => { notified.push(id); }));
  restores.push(stub(Product as any, 'updateOne', () => fakeQuery({ modifiedCount: 1 }))); // aggregate recompute
  let after = 2;
  restores.push(stub(Product as any, 'findOneAndUpdate', () => fakeQuery({ _id: OID(1), variants: [{ _id: V, stockQty: after }] })));
  let n = await returnStock([{ product: OID(1), variant: V, quantity: 2 }] as any);
  assert.equal(n, 1);
  assert.equal(notified.length, 1, 'was sold out -> rebuild');
  after = 7;
  n = await returnStock([{ product: OID(1), variant: V, quantity: 2 }] as any);
  assert.equal(n, 1);
  assert.equal(notified.length, 1, 'still in stock -> no rebuild');
});

test('stock return: product without variants follows the same rule; missing product returns nothing', async () => {
  const notified: unknown[] = [];
  restores.push(stub(hooks as any, 'notifyStockAvailabilityChanged', (id: unknown) => { notified.push(id); }));
  let doc: any = { _id: OID(1), stockQuantity: 1 };
  restores.push(stub(Product as any, 'findOneAndUpdate', () => fakeQuery(doc)));
  assert.equal(await returnStock([{ product: OID(1), variant: null, quantity: 1 }] as any), 1);
  assert.equal(notified.length, 1);
  doc = null;
  assert.equal(await returnStock([{ product: OID(2), variant: null, quantity: 1 }] as any), 0);
  assert.equal(notified.length, 1);
});
