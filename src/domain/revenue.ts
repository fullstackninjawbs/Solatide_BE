/**
 * revenue.ts — shared reporting definitions (M-14).
 * Revenue-bearing orders: paid / partially_refunded / refunded, not soft-deleted.
 * Net revenue per order = grandTotal (fallback deprecated totalAmount) − refundedAmount.
 */
export const REVENUE_PAYMENT_STATUSES = ['paid', 'partially_refunded', 'refunded'];

export function buildRevenueMatch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    paymentStatus: { $in: REVENUE_PAYMENT_STATUSES },
    isDeleted: { $ne: true },
  };
}

export const grossRevenueExpr = { $ifNull: ['$grandTotal', { $ifNull: ['$totalAmount', 0] }] };

export const netRevenueExpr = {
  $subtract: [grossRevenueExpr, { $ifNull: ['$refundedAmount', 0] }],
};

/** Analytics-event filter that excludes client-reported (spoofable) purchase events. */
export const trustedEventFilter = { clientReported: { $ne: true } };
