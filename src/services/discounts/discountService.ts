/**
 * discountService.ts — discount codes at our checkout (Order Request and Bank Transfer).
 *
 * The server always recalculates: the browser only sends the code. A use is counted when a bank
 * transfer order is placed (reserveDiscountUse, guarded by maxUses) and given back if that order is
 * cancelled (releaseDiscountUse). Orders created in Admin count their use when paid (onOrderPaid).
 */
import Discount from '../../models/Discount';
import Order from '../../models/order.model';
import { computeDiscount, type CartLine, type DiscountResult } from '../../domain/discountEngine';
import { escapeRegExp } from '../../domain/escapeRegExp';

export const DISCOUNT_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function findDiscountByCode(code: string): Promise<any | null> {
  const c = String(code || '').trim();
  if (!DISCOUNT_CODE_RE.test(c)) return null;
  return Discount.findOne({ code: { $regex: `^${escapeRegExp(c, 64)}$`, $options: 'i' } }).lean();
}

/** Earlier orders of this customer with the code (paid, or placed and awaiting payment). */
export async function customerUsesOf(code: string, email: string, excludeOrderId?: unknown): Promise<number> {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return 0;
  const filter: any = {
    couponCode: code,
    customerEmail: e,
    paymentStatus: { $nin: ['cancelled', 'failed'] },
    isDeleted: { $ne: true },
  };
  if (excludeOrderId) filter._id = { $ne: excludeOrderId };
  return Order.countDocuments(filter);
}

export type AppliedDiscount = Extract<DiscountResult, { ok: true }> & { code: string; discountId: unknown; description: string };

/** Check a code against cart lines for a customer. */
export async function applyDiscountCode(
  code: string,
  lines: CartLine[],
  email?: string
): Promise<{ ok: true; discount: AppliedDiscount } | { ok: false; reason: string; code: string }> {
  const d = await findDiscountByCode(code);
  if (!d) return { ok: false, code: 'not_found', reason: "This discount code isn't valid." };
  const customerUses = email ? await customerUsesOf(d.code, email) : undefined;
  const r = computeDiscount(d, lines, { customerUses });
  if (!r.ok) return r;
  return { ok: true, discount: { ...r, code: d.code, discountId: d._id, description: `${d.code} (${r.label})` } };
}

/** Count one use now; false when the usage limit was reached in the meantime. */
export async function reserveDiscountUse(discountId: unknown): Promise<boolean> {
  const updated: any = await Discount.findOneAndUpdate(
    { _id: discountId, $or: [{ maxUses: { $lte: 0 } }, { maxUses: null }, { $expr: { $lt: ['$usesSoFar', '$maxUses'] } }] },
    { $inc: { usesSoFar: 1 } },
    { new: true }
  ).lean();
  if (!updated) return false;
  if (updated.maxUses > 0 && updated.usesSoFar >= updated.maxUses) {
    await Discount.updateOne({ _id: discountId, status: 'active' }, { $set: { status: 'expired' } });
  }
  return true;
}

/** Give back a use reserved for an order that was then not created. */
export async function undoReservedUse(discountId: unknown): Promise<void> {
  await Discount.updateOne({ _id: discountId, usesSoFar: { $gt: 0 } }, { $inc: { usesSoFar: -1 } });
}

/** Undo a reserved use (cancelled / deleted unpaid order). Runs at most once per order. */
export async function releaseDiscountUse(orderId: unknown): Promise<boolean> {
  // If the order is paid after all ("late payment"), the paid side effects count the use again
  const order: any = await Order.findOneAndUpdate(
    { _id: orderId, discountUsageReservedAt: { $ne: null }, discountUsageReleasedAt: null, paymentStatus: 'cancelled' },
    { $set: { discountUsageReleasedAt: new Date() }, $pull: { sideEffectStepsDone: 'discount_usage' } },
    { new: true }
  ).select('couponCode').lean();
  if (!order?.couponCode) return false;
  const d: any = await Discount.findOneAndUpdate(
    { code: order.couponCode, usesSoFar: { $gt: 0 } },
    { $inc: { usesSoFar: -1 } },
    { new: true }
  ).lean();
  // Expired only because the limit was reached → usable again
  if (d && d.status === 'expired' && d.maxUses > 0 && d.usesSoFar < d.maxUses && (!d.activeTo || new Date(d.activeTo) > new Date())) {
    await Discount.updateOne({ _id: d._id }, { $set: { status: 'active' } });
  }
  console.log(`[Discount] Released a use of ${order.couponCode} (order ${orderId} cancelled)`);
  return true;
}
