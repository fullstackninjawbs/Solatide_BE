/**
 * money.ts
 * ────────
 * Unit conversion and refund-amount validation.
 *
 * TagadaPay amounts are MINOR units (cents): the SDK README processes
 * `amount: 4999` for $49.99 and variant `price: 2999`; order summaries
 * (`totalAdjustedAmount`, `unitAmount`, …) were already divided by 100 in the
 * original webhook code. Our database stores MAJOR units (dollars, 2 dp).
 * All conversions go through these two helpers.
 */

export function toMinorUnits(major: number): number {
  if (!Number.isFinite(major)) throw new Error(`Invalid amount: ${major}`);
  return Math.round(major * 100);
}

export function fromMinorUnits(minor: number | string | null | undefined): number {
  const n = typeof minor === 'string' ? Number(minor) : minor;
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

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

/**
 * Refunds are disabled unless explicitly enabled. Default: enabled in the
 * Tagada sandbox, disabled in production — the business owner decides by
 * setting REFUNDS_ENABLED=true.
 */
export function refundsEnabled(env: NodeJS.ProcessEnv, tagadaEnv: string): boolean {
  const flag = env.REFUNDS_ENABLED;
  if (flag !== undefined && flag !== '') return ['true', '1', 'yes'].includes(flag.toLowerCase());
  return tagadaEnv === 'sandbox';
}
