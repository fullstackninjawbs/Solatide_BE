/**
 * refunds.ts — race-safe refund accounting (H-6).
 *
 * Order.refundedAmount = reserved (in-flight) + confirmed refunds, major units.
 * Order.pendingRefundAmount = the in-flight part awaiting provider confirmation.
 * A reservation is one conditional update guarded by
 *   refundedAmount + amt ≤ grandTotal
 * so concurrent refunds can never exceed the order total.
 */
import Order from '../../models/order.model';
import Refund from '../../models/Refund';
import { fromMinorUnits, roundMoney } from '../../domain/money';
import { PaymentStatus } from '../../domain/orderTransitions';
import { transitionPaymentStatus } from './paymentTransition';
import { isDuplicateKeyError } from './orderNumber';

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

/** Undo a reservation after a provider failure. */
export async function releaseRefund(orderId: unknown, amount: number, opts: { pending?: boolean } = {}): Promise<void> {
  const amt = roundMoney(amount);
  const pendingDec = opts.pending === false ? 0 : amt;
  await Order.updateOne({ _id: orderId }, [
    {
      $set: {
        refundedAmount: { $max: [0, { $round: [{ $subtract: [{ $ifNull: ['$refundedAmount', 0] }, amt] }, 2] }] },
        pendingRefundAmount: { $max: [0, { $round: [{ $subtract: [{ $ifNull: ['$pendingRefundAmount', 0] }, pendingDec] }, 2] }] },
      },
    },
  ]);
}

/** Provider confirmed an in-flight refund: it stays in refundedAmount, leaves pending. */
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

/** Extract a provider refund id from an SDK refund() response (shape not typed: `Promise<unknown>`). */
export function extractRefundId(res: any): string | null {
  const candidates = [
    res?.refund?.id, res?.refundId, res?.refund_id, res?.id,
    res?.refunds?.[0]?.id, res?.transactions?.find?.((t: any) => /refund/i.test(String(t?.type)))?.id,
    Array.isArray(res) ? res[0]?.id : undefined,
  ];
  const id = candidates.find((c) => typeof c === 'string' && c.trim() && c.toLowerCase() !== 'unknown');
  return id ? String(id) : null;
}

interface ProviderRefundTxn {
  id: string;
  amount: number; // major units
}

/** Refund transactions reported on a Tagada Payment object (amounts converted from minor units). */
export function extractProviderRefunds(d: any): { txns: ProviderRefundTxn[]; total: number | null } {
  const txns: ProviderRefundTxn[] = [];
  const list: any[] = Array.isArray(d?.transactions) ? d.transactions : [];
  for (const t of list) {
    if (!/refund/i.test(String(t?.type ?? ''))) continue;
    const st = String(t?.status ?? '').toLowerCase();
    if (st && !['succeeded', 'success', 'approved', 'completed', 'captured', 'refunded'].includes(st)) continue;
    if (typeof t?.id === 'string' && t.id) txns.push({ id: t.id, amount: fromMinorUnits(Math.abs(Number(t.amount) || 0)) });
  }
  const singleId = d?.refund?.id ?? d?.refundId ?? d?.refund_id;
  const singleAmt = d?.refund?.amount ?? d?.refundAmount;
  if (typeof singleId === 'string' && singleId && !txns.some((t) => t.id === singleId) && singleAmt != null) {
    txns.push({ id: singleId, amount: fromMinorUnits(Math.abs(Number(singleAmt) || 0)) });
  }
  const explicitTotal = d?.amount_refunded ?? d?.refundedAmount ?? d?.totalRefundedAmount ?? d?.amountRefunded;
  let total: number | null = null;
  if (txns.length) total = roundMoney(txns.reduce((s, t) => s + t.amount, 0));
  else if (explicitTotal != null && Number.isFinite(Number(explicitTotal))) total = fromMinorUnits(Number(explicitTotal));
  return { txns, total };
}

/**
 * Apply a refund webhook. Idempotent: pending Refunds are matched by
 * tagadaRefundId (or same amount), provider-initiated refunds are created once
 * (unique tagadaRefundId), and amounts are reconciled to the provider total
 * rather than blindly added.
 */
export async function applyProviderRefundEvent(orderId: unknown, d: any, mapped: PaymentStatus | null): Promise<void> {
  const order: any = await Order.findById(orderId).lean();
  if (!order) return;
  const grandTotal = Number(order.grandTotal ?? order.totalAmount ?? 0);
  const { txns, total } = extractProviderRefunds(d);

  for (const txn of txns) {
    const existing: any = await Refund.findOne({ tagadaRefundId: txn.id });
    if (existing) {
      if (existing.status === 'pending') {
        existing.status = 'succeeded';
        await existing.save();
        await confirmReservedRefund(orderId, existing.amount);
      }
      continue;
    }
    const pendingMatch: any = await Refund.findOne({
      order: orderId, status: 'pending', $or: [{ tagadaRefundId: null }, { tagadaRefundId: { $exists: false } }],
      amount: { $gte: txn.amount - EPS, $lte: txn.amount + EPS },
    }).sort({ createdAt: 1 });
    if (pendingMatch) {
      pendingMatch.status = 'succeeded';
      pendingMatch.tagadaRefundId = txn.id;
      await pendingMatch.save();
      await confirmReservedRefund(orderId, pendingMatch.amount);
      continue;
    }
    // Refund initiated outside our admin (e.g. Tagada dashboard)
    const reserved = await reserveRefund(orderId, txn.amount, { pending: false });
    if (!reserved) {
      console.error(`[Refund] order=${orderId} provider refund ${txn.id} (${txn.amount}) exceeds remaining — not recorded; investigate`);
      continue;
    }
    try {
      await Refund.create({
        order: orderId, amount: txn.amount, reason: 'Initiated from Tagada Dashboard',
        type: txn.amount + EPS >= grandTotal ? 'full' : 'partial', status: 'succeeded',
        source: 'provider_webhook', tagadaRefundId: txn.id,
      });
    } catch (err) {
      await releaseRefund(orderId, txn.amount, { pending: false });
      if (!isDuplicateKeyError(err)) throw err;
    }
  }

  // Reconcile to the provider total when per-transaction data is absent.
  const after: any = await Order.findById(orderId).lean();
  const providerTotal = total ?? (mapped === 'refunded' ? grandTotal : null);
  if (providerTotal != null && txns.length === 0) {
    const delta = roundMoney(providerTotal - Number(after.refundedAmount || 0));
    if (delta > EPS) {
      const reserved = await reserveRefund(orderId, delta, { pending: false });
      if (reserved) {
        await Refund.create({
          order: orderId, amount: delta, reason: 'Initiated from Tagada Dashboard',
          type: providerTotal + EPS >= grandTotal && !after.refundedAmount ? 'full' : 'partial',
          status: 'succeeded', source: 'provider_webhook', tagadaRefundId: null,
        });
      }
    }
    if (providerTotal + EPS >= Number(after.refundedAmount || 0)) {
      // Every in-flight reservation is covered by the provider total.
      const pendings = await Refund.find({ order: orderId, status: 'pending' });
      for (const p of pendings) {
        p.status = 'succeeded';
        await p.save();
        await confirmReservedRefund(orderId, p.amount);
      }
    }
  } else if (providerTotal == null && txns.length === 0) {
    // No amount information at all: confirm the oldest pending refund, never add amounts.
    const oldest: any = await Refund.findOne({ order: orderId, status: 'pending' }).sort({ createdAt: 1 });
    if (oldest) {
      oldest.status = 'succeeded';
      await oldest.save();
      await confirmReservedRefund(orderId, oldest.amount);
    } else {
      console.warn(`[Refund] order=${orderId} refund event without amount and no pending refund — no amount recorded`);
    }
  }

  const final: any = await Order.findById(orderId).lean();
  if (Number(final.refundedAmount || 0) > 0) {
    await transitionPaymentStatus(orderId, refundTargetStatus(final));
  }
}
