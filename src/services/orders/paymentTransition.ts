/**
 * paymentTransition.ts — atomic, guarded payment-status changes (H-5).
 *
 * The update filter includes `paymentStatus ∈ allowedPredecessors(to)`, so two
 * concurrent writers cannot both apply conflicting transitions and a late
 * event can never move a paid order back. Order/fulfilment/delivery fields are
 * only initialised (pipeline $cond) — never reset once the order has progressed.
 */
import Order from '../../models/order.model';
import { PaymentStatus, allowedPredecessors, planPaymentTransition, isPaymentStatus } from '../../domain/orderTransitions';

export type TransitionOutcome =
  | { result: 'applied'; order: any; from: PaymentStatus; to: PaymentStatus }
  | { result: 'noop'; order: any; from: PaymentStatus; to: PaymentStatus }
  | { result: 'rejected'; order: any; from: PaymentStatus; to: PaymentStatus; reason: string }
  | { result: 'not_found' };

export async function transitionPaymentStatus(
  orderId: unknown,
  to: PaymentStatus,
  opts: { extraSet?: Record<string, unknown>; now?: Date } = {}
): Promise<TransitionOutcome> {
  const now = opts.now ?? new Date();
  const current: any = await Order.findById(orderId).lean();
  if (!current) return { result: 'not_found' };
  const from: PaymentStatus = isPaymentStatus(current.paymentStatus) ? current.paymentStatus : 'pending';
  const plan = planPaymentTransition(from, to);

  if (plan.action === 'noop') return { result: 'noop', order: current, from, to };
  if (plan.action === 'reject') {
    console.warn(`[PaymentTransition] order=${orderId} rejected: ${plan.reason}`);
    return { result: 'rejected', order: current, from, to, reason: plan.reason };
  }

  const set: Record<string, unknown> = { paymentStatus: to, ...(opts.extraSet ?? {}) };
  const stages: any[] = [{ $set: set }];

  if (to === 'paid') {
    stages.push({
      $set: {
        paidAt: { $ifNull: ['$paidAt', now] },
        // Only move a *pending* order forward; shipped/delivered/cancelled/processing stay as-is.
        status: { $cond: [{ $in: [{ $ifNull: ['$status', 'pending'] }, ['pending']] }, 'processing', '$status'] },
        fulfilmentStatus: { $ifNull: ['$fulfilmentStatus', 'unfulfilled'] },
        deliveryStatus: { $ifNull: ['$deliveryStatus', 'pending'] },
      },
    });
  } else if (to === 'refunded') {
    stages.push({ $set: { refundStatus: 'refunded' } });
  } else if (to === 'partially_refunded') {
    stages.push({ $set: { refundStatus: 'partially_refunded' } });
  } else if (to === 'cancelled') {
    stages.push({ $set: { status: { $cond: [{ $eq: ['$status', 'pending'] }, 'cancelled', '$status'] } } });
  }

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, paymentStatus: { $in: allowedPredecessors(to) } },
    stages,
    { new: true }
  ).lean();

  if (!updated) {
    // Lost a race — re-read and report what happened.
    const fresh: any = await Order.findById(orderId).lean();
    if (fresh?.paymentStatus === to) return { result: 'noop', order: fresh, from: fresh.paymentStatus, to };
    return { result: 'rejected', order: fresh, from: fresh?.paymentStatus, to, reason: 'Concurrent status change' };
  }
  console.log(`[PaymentTransition] order=${orderId} ${from} → ${to}`);
  return { result: 'applied', order: updated, from, to };
}
