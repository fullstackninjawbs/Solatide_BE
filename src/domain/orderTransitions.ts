/**
 * orderTransitions.ts
 * ───────────────────
 * Pure, side-effect-free rules for order payment-status transitions and for
 * mapping TagadaPay statuses/events to our internal payment status.
 *
 * Forward-only state machine (H-5):
 *   pending            → paid | failed | cancelled
 *   failed             → paid            (customer retried and succeeded)
 *   cancelled          → paid            (late success for an abandoned session)
 *   paid               → partially_refunded | refunded
 *   partially_refunded → partially_refunded | refunded
 *   refunded           → (terminal)
 * A paid order can never go back to pending/failed/cancelled.
 */

export type PaymentStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded';

export const PAYMENT_STATUSES: PaymentStatus[] = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
];

const ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['paid', 'failed', 'cancelled'],
  failed: ['paid'],
  cancelled: ['paid'],
  paid: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  refunded: [],
};

export function isPaymentStatus(v: unknown): v is PaymentStatus {
  return typeof v === 'string' && (PAYMENT_STATUSES as string[]).includes(v);
}

/**
 * True when `from → to` is a legal transition. A same-state "transition" is
 * reported as allowed only where it is meaningful (partially_refunded →
 * partially_refunded, i.e. another partial refund); callers treat other
 * same-state cases as a no-op via `planPaymentTransition`.
 */
export function canTransitionPayment(from: PaymentStatus | undefined | null, to: PaymentStatus): boolean {
  const current: PaymentStatus = from && isPaymentStatus(from) ? from : 'pending';
  return ALLOWED[current].includes(to);
}

/** The set of statuses from which `to` may be reached (used in atomic DB filters). */
export function allowedPredecessors(to: PaymentStatus): PaymentStatus[] {
  return PAYMENT_STATUSES.filter((s) => ALLOWED[s].includes(to));
}

export type TransitionPlan =
  | { action: 'apply'; from: PaymentStatus; to: PaymentStatus }
  | { action: 'noop'; from: PaymentStatus; to: PaymentStatus }
  | { action: 'reject'; from: PaymentStatus; to: PaymentStatus; reason: string };

export function planPaymentTransition(from: PaymentStatus | undefined | null, to: PaymentStatus): TransitionPlan {
  const current: PaymentStatus = from && isPaymentStatus(from) ? from : 'pending';
  if (current === to && to !== 'partially_refunded') return { action: 'noop', from: current, to };
  if (canTransitionPayment(current, to)) return { action: 'apply', from: current, to };
  return { action: 'reject', from: current, to, reason: `Illegal payment transition ${current} → ${to}` };
}

/** Order statuses that must never be reset by a (repeated) payment event. */
const ADVANCED_ORDER_STATUSES = ['shipped', 'delivered', 'cancelled'];

export function isFulfilmentAdvanced(order: {
  status?: string | null;
  fulfilmentStatus?: string | null;
  deliveryStatus?: string | null;
}): boolean {
  return (
    ADVANCED_ORDER_STATUSES.includes(String(order.status ?? '')) ||
    (order.fulfilmentStatus != null && order.fulfilmentStatus !== 'unfulfilled') ||
    (order.deliveryStatus != null && order.deliveryStatus !== 'pending')
  );
}

/**
 * Fields to $set when an order becomes paid. Never touches fulfilment/delivery
 * of an order that has already progressed (shipped/fulfilled/delivered).
 */
export function paidStatusSideFields(order: {
  status?: string | null;
  fulfilmentStatus?: string | null;
  deliveryStatus?: string | null;
}): Record<string, unknown> {
  if (isFulfilmentAdvanced(order)) return {};
  const fields: Record<string, unknown> = {};
  if (!order.status || order.status === 'pending') fields.status = 'processing';
  if (!order.fulfilmentStatus) fields.fulfilmentStatus = 'unfulfilled';
  if (!order.deliveryStatus) fields.deliveryStatus = 'pending';
  return fields;
}

/**
 * Map a TagadaPay status and/or webhook event type to our payment status.
 * Returns null when the status carries no payment-state information.
 *
 * NOTE: partially_refunded maps to 'partially_refunded' (refund branch), never
 * to 'paid' (H-5).
 */
export function mapTagadaStatus(tagadaStatus?: string | null, eventType?: string | null): PaymentStatus | null {
  const ev = String(eventType ?? '').toLowerCase();
  if (ev === 'order/paid' || ev === 'payment/succeeded' || ev === 'payment/captured') return 'paid';
  if (ev === 'order/refunded' || ev === 'payment/refunded') {
    return String(tagadaStatus ?? '').toLowerCase() === 'partially_refunded' ? 'partially_refunded' : 'refunded';
  }
  if (ev === 'payment/partially_refunded') return 'partially_refunded';
  if (ev === 'order/failed' || ev === 'payment/failed' || ev === 'payment/rejected') return 'failed';

  switch (String(tagadaStatus ?? '').toLowerCase()) {
    case 'succeeded':
    case 'paid':
    case 'captured':
    case 'authorized':
    case 'completed':
      return 'paid';
    case 'partially_refunded':
      return 'partially_refunded';
    case 'refunded':
      return 'refunded';
    case 'failed':
    case 'declined':
    case 'error':
    case 'rejected':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'voided':
    case 'expired':
      return 'cancelled';
    case 'pending':
    case 'created':
    case 'initiated':
      return 'pending';
    default:
      return null;
  }
}
