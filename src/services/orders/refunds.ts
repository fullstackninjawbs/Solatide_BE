/**
 * refunds.ts — race-safe refund accounting (H-6).
 *
 * Order.refundedAmount = reserved (in-flight) + confirmed refunds, major units.
 * Order.pendingRefundAmount = the in-flight part (reserved, not yet recorded as done).
 * Refunds are record-only: no payment provider is called (the money is returned
 * outside the admin), so a reservation is confirmed straight away.
 * A reservation is one conditional update guarded by
 *   refundedAmount + amt ≤ grandTotal
 * so concurrent refunds can never exceed the order total.
 */
import Order from '../../models/order.model';
import { roundMoney } from '../../domain/money';
import { PaymentStatus } from '../../domain/orderTransitions';

const EPS = 0.005;

export async function reserveRefund(orderId: unknown, amount: number, opts: { pending?: boolean } = {}): Promise<any | null> {
  const amt = roundMoney(amount);
  if (!(amt > 0)) return null;
  const pendingInc = opts.pending === false ? 0 : amt;
  return Order.findOneAndUpdate(
    {
      _id: orderId,
      paymentStatus: { $in: ['paid', 'partially_refunded'] },
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ['$refundedAmount', 0] }, amt] },
          { $add: [{ $ifNull: ['$grandTotal', { $ifNull: ['$totalAmount', 0] }] }, EPS] },
        ],
      },
    },
    [
      {
        $set: {
          refundedAmount: { $round: [{ $add: [{ $ifNull: ['$refundedAmount', 0] }, amt] }, 2] },
          pendingRefundAmount: { $round: [{ $add: [{ $ifNull: ['$pendingRefundAmount', 0] }, pendingInc] }, 2] },
        },
      },
    ],
    { new: true }
  ).lean();
}

/** A reserved refund is done: it stays in refundedAmount, leaves pending. */
export async function confirmReservedRefund(orderId: unknown, amount: number): Promise<void> {
  const amt = roundMoney(amount);
  await Order.updateOne({ _id: orderId }, [
    { $set: { pendingRefundAmount: { $max: [0, { $round: [{ $subtract: [{ $ifNull: ['$pendingRefundAmount', 0] }, amt] }, 2] }] } } },
  ]);
}

export function refundTargetStatus(order: { grandTotal?: number | null; totalAmount?: number | null; refundedAmount?: number | null }): PaymentStatus {
  const total = Number(order.grandTotal ?? order.totalAmount ?? 0);
  const refunded = Number(order.refundedAmount ?? 0);
  return refunded + EPS >= total ? 'refunded' : 'partially_refunded';
}
