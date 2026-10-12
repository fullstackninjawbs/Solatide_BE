/**
 * discountEligibility.ts — pure rules for local enforcement of discount limits (M-12).
 */
export interface DiscountLike {
  code: string;
  status?: string;
  activeFrom?: Date | string | null;
  activeTo?: Date | string | null;
  maxUses?: number | null;       // 0 / null = unlimited
  usesSoFar?: number | null;
  minPurchase?: number | null;   // major units, 0 = none
  minQuantity?: number | null;
  perCustomerLimit?: number | null; // 0 / null = unlimited
}

export type EligibilityResult = { ok: true } | { ok: false; reason: string; code: string };

export function checkDiscountEligibility(
  discount: DiscountLike | null | undefined,
  ctx: { now?: Date; subtotal?: number; quantity?: number; customerUses?: number; countCurrentOrder?: boolean }
): EligibilityResult {
  if (!discount) return { ok: false, code: 'not_found', reason: 'Discount code not found.' };
  const now = ctx.now ?? new Date();

  if (discount.status && discount.status !== 'active') {
    return { ok: false, code: 'inactive', reason: `Discount code is ${discount.status}.` };
  }
  if (discount.activeFrom && new Date(discount.activeFrom).getTime() > now.getTime()) {
    return { ok: false, code: 'not_started', reason: 'Discount code is not active yet.' };
  }
  if (discount.activeTo && new Date(discount.activeTo).getTime() < now.getTime()) {
    return { ok: false, code: 'expired', reason: 'Discount code has expired.' };
  }
  const maxUses = Number(discount.maxUses) || 0;
  if (maxUses > 0 && (Number(discount.usesSoFar) || 0) >= maxUses) {
    return { ok: false, code: 'max_uses', reason: 'Discount code usage limit has been reached.' };
  }
  const minPurchase = Number(discount.minPurchase) || 0;
  if (minPurchase > 0 && (Number(ctx.subtotal) || 0) < minPurchase) {
    return { ok: false, code: 'min_purchase', reason: `A minimum purchase of ${minPurchase} is required.` };
  }
  const minQty = Number(discount.minQuantity) || 0;
  if (minQty > 0 && ctx.quantity != null && ctx.quantity < minQty) {
    return { ok: false, code: 'min_quantity', reason: `A minimum quantity of ${minQty} is required.` };
  }
  const perCustomer = Number(discount.perCustomerLimit) || 0;
  if (perCustomer > 0 && ctx.customerUses != null && ctx.customerUses >= perCustomer) {
    return { ok: false, code: 'per_customer', reason: 'Discount code already used the maximum number of times by this customer.' };
  }
  return { ok: true };
}

/** Whitelist of admin-editable discount fields (no mass assignment). */
export function pickDiscountFields(body: any, { partial }: { partial: boolean }): { data: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};
  const b = body && typeof body === 'object' ? body : {};

  if (b.code !== undefined) {
    const code = String(b.code).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) errors.push('code must be 1-64 chars of letters, digits, _ or -');
    else data.code = code;
  } else if (!partial) errors.push('code is required');

  if (b.type !== undefined) {
    if (!['percent', 'fixed'].includes(b.type)) errors.push("type must be 'percent' or 'fixed'");
    else data.type = b.type;
  }
  if (b.value !== undefined) {
    const v = Number(b.value);
    if (!Number.isFinite(v) || v < 0) errors.push('value must be a non-negative number');
    else if (b.type === 'percent' && v > 100) errors.push('percent value cannot exceed 100');
    else data.value = v;
  } else if (!partial) errors.push('value is required');

  if (b.appliesTo !== undefined) {
    if (!['all', 'products', 'collections'].includes(b.appliesTo)) errors.push('invalid appliesTo');
    else data.appliesTo = b.appliesTo;
  }
  for (const f of ['minPurchase', 'minQuantity', 'maxUses', 'perCustomerLimit']) {
    if (b[f] !== undefined && b[f] !== null && b[f] !== '') {
      const v = Number(b[f]);
      if (!Number.isFinite(v) || v < 0) errors.push(`${f} must be a non-negative number`);
      else data[f] = f === 'minPurchase' ? v : Math.floor(v);
    }
  }
  for (const f of ['activeFrom', 'activeTo']) {
    if (b[f] === null || b[f] === '') data[f] = null;
    else if (b[f] !== undefined) {
      const d = new Date(b[f]);
      if (Number.isNaN(d.getTime())) errors.push(`${f} must be a valid date`);
      else data[f] = d;
    }
  }
  if (b.status !== undefined) {
    if (!['active', 'expired', 'disabled'].includes(b.status)) errors.push('invalid status');
    else data.status = b.status;
  }
  if (b.combinations !== undefined && typeof b.combinations === 'object' && b.combinations) {
    data.combinations = {
      product: !!b.combinations.product,
      order: !!b.combinations.order,
      shipping: !!b.combinations.shipping,
    };
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) errors.push('tags must be an array');
    else data.tags = b.tags.map((t: unknown) => String(t).slice(0, 64)).slice(0, 50);
  }
  if (b.salesChannelAccess !== undefined) data.salesChannelAccess = !!b.salesChannelAccess;
  // usesSoFar, tagadaPromotionId, tagadaPromotionCodeId are server-managed — never accepted from the client.
  return { data, errors };
}
