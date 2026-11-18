/**
 * money.ts
 * ────────
 * Rounding and refund-amount validation. Our database stores MAJOR units
 * (dollars, 2 dp).
 */

/** Round to cents, avoiding float drift (0.1 + 0.2). */
export function roundMoney(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function hasAtMostTwoDecimals(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

export type RefundValidation =
  | { ok: true; amount: number; type: 'full' | 'partial'; remaining: number }
  | { ok: false; status: number; error: string };

/**
 * Validate an admin refund request.
 *  - amount must be a finite number > 0, ≤ remaining, with ≤ 2 decimals
 *  - amount 0 / absent is only accepted as an explicit full refund (`full: true`)
 */
export function validateRefundRequest(input: {
  amount?: unknown;
  full?: unknown;
  grandTotal?: number | null;
  refundedAmount?: number | null;
}): RefundValidation {
  const grandTotal = roundMoney(Number(input.grandTotal) || 0);
  const refunded = roundMoney(Number(input.refundedAmount) || 0);
  const remaining = roundMoney(grandTotal - refunded);

  if (remaining <= 0) return { ok: false, status: 400, error: 'Nothing left to refund on this order.' };

  const isFull = input.full === true || input.full === 'true';
  const raw = input.amount;
  const absent = raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0';

  if (absent) {
    if (!isFull) {
      return { ok: false, status: 400, error: 'Refund amount is required (or send full: true for a full refund of the remaining balance).' };
    }
    return { ok: true, amount: remaining, type: refunded > 0 ? 'partial' : 'full', remaining };
  }

  const amount = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(amount)) return { ok: false, status: 400, error: 'Refund amount must be a finite number.' };
  if (amount <= 0) return { ok: false, status: 400, error: 'Refund amount must be greater than 0.' };
  if (!hasAtMostTwoDecimals(amount)) return { ok: false, status: 400, error: 'Refund amount may have at most 2 decimal places.' };
  if (roundMoney(amount) > remaining) {
    return { ok: false, status: 400, error: `Refund amount (${amount}) exceeds the remaining refundable amount (${remaining}).` };
  }
  const amt = roundMoney(amount);
  const type: 'full' | 'partial' = refunded === 0 && amt === grandTotal ? 'full' : 'partial';
  return { ok: true, amount: amt, type, remaining };
}
