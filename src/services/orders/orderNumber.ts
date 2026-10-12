import crypto from 'crypto';
import Order from '../../models/order.model';

/** Random human-readable order number like SLT1234567B. */
export function randomOrderNumber(): string {
  const padded = String(crypto.randomInt(1, 10000000)).padStart(7, '0');
  return `SLT${padded}B`;
}

/**
 * Generate an order number not currently in use. There is still a race between
 * this check and the insert, so callers that insert should use
 * `withOrderNumberRetry`, which retries on E11000.
 */
export async function generateOrderNumber(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const orderNumber = randomOrderNumber();
    const existing = await Order.findOne({ orderNumber }).select('_id').lean();
    if (!existing) return orderNumber;
  }
  throw new Error('Unable to generate a unique order number');
}

export function isDuplicateKeyError(err: any, field?: string): boolean {
  if (!err || (err.code !== 11000 && err.code !== 11001)) return false;
  if (!field) return true;
  const keys = Object.keys(err.keyPattern ?? err.keyValue ?? {});
  if (keys.length) return keys.includes(field);
  return String(err.message ?? '').includes(field);
}

/**
 * Run `fn(orderNumber)` (which must insert/update with that number) and retry
 * with a fresh number up to `attempts` times on an orderNumber E11000.
 */
export async function withOrderNumberRetry<T>(fn: (orderNumber: string) => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const orderNumber = await generateOrderNumber();
    try {
      return await fn(orderNumber);
    } catch (err) {
      if (!isDuplicateKeyError(err, 'orderNumber')) throw err;
      lastErr = err;
      console.warn(`[OrderNumber] Collision on attempt ${i + 1}/${attempts}, retrying`);
    }
  }
  throw lastErr;
}

/** Assign an orderNumber to an existing order that lacks one (idempotent, collision-safe). */
export async function ensureOrderNumber(orderId: unknown): Promise<string | undefined> {
  const current = await Order.findById(orderId).select('orderNumber').lean();
  if (!current) return undefined;
  if (current.orderNumber) return current.orderNumber;
  return withOrderNumberRetry(async (orderNumber) => {
    const res = await Order.findOneAndUpdate(
      { _id: orderId, $or: [{ orderNumber: { $exists: false } }, { orderNumber: null }, { orderNumber: '' }] },
      { $set: { orderNumber } },
      { new: true, projection: { orderNumber: 1 } }
    ).lean();
    if (res?.orderNumber) return res.orderNumber;
    const again = await Order.findById(orderId).select('orderNumber').lean();
    return again?.orderNumber;
  });
}
