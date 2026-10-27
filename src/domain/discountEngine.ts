/**
 * discountEngine.ts — pure rules for applying a hub discount to a cart (no database).
 *
 * A discount applies when it is usable (status, dates, usage limits — discountEligibility.ts) and
 * its rules match: all of them (ruleMatch 'all') or at least one ('any'); no rules = always.
 * The action is an order discount (percent or fixed) on the items subtotal; shipping is never
 * discounted, and products in an "excluded products" rule are never discounted.
 *
 * Rules:
 *   cart_min_quantity      at least `quantity` units; `products` do not count toward it
 *   cart_total_min         items subtotal at least `amount`
 *   cart_total_max         items subtotal at most `amount`
 *   cart_contains_product  the cart has any of `products`
 *   excluded_products      `products` are never discounted (the cart needs another item)
 *   max_product_quantity   no product with more than `quantity` units
 */
import { checkDiscountEligibility, type DiscountLike } from './discountEligibility';

export const RULE_TYPES = [
  'cart_min_quantity', 'cart_total_min', 'cart_total_max', 'cart_contains_product', 'excluded_products', 'max_product_quantity',
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export interface Rule { type: RuleType; quantity?: number | null; amount?: number | null; products?: unknown[] | null }
export interface CartLine { productId: string; quantity: number; price: number }
export interface DiscountForEngine extends DiscountLike {
  type?: string; // 'percent' | 'fixed'
  value?: number | null;
  ruleMatch?: 'all' | 'any' | string | null;
  rules?: Rule[] | null;
}

export type DiscountResult =
  | { ok: true; amount: number; base: number; label: string }
  | { ok: false; code: string; reason: string };

const round2 = (n: number) => Math.round(n * 100) / 100;
const ids = (list: unknown[] | null | undefined) => new Set((list || []).map((x) => String(x)));
const money = (n: number) => `$${round2(n).toFixed(2)}`;

/** Whether one rule matches the cart, with a customer-friendly reason when it does not. */
export function ruleMatches(rule: Rule, lines: CartLine[]): { ok: boolean; reason: string } {
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
  const q = Math.max(0, Math.floor(Number(rule.quantity) || 0));
  const amount = Math.max(0, Number(rule.amount) || 0);
  const products = ids(rule.products);
  switch (rule.type) {
    case 'cart_min_quantity': {
      const counted = lines.filter((l) => !products.has(l.productId)).reduce((s, l) => s + l.quantity, 0);
      return { ok: counted >= q, reason: products.size ? `Add at least ${q} eligible items to use this code (some items do not count).` : `Add at least ${q} items to use this code.` };
    }
    case 'cart_total_min':
      return { ok: subtotal >= amount, reason: `Spend at least ${money(amount)} to use this code.` };
    case 'cart_total_max':
      return { ok: subtotal <= amount, reason: `This code is for orders up to ${money(amount)}.` };
    case 'cart_contains_product':
      return { ok: lines.some((l) => products.has(l.productId)), reason: 'This code needs a specific product in your cart.' };
    case 'excluded_products':
      return { ok: lines.some((l) => !products.has(l.productId)), reason: "This code doesn't apply to the items in your cart." };
    case 'max_product_quantity':
      return { ok: lines.every((l) => l.quantity <= q), reason: `This code allows at most ${q} of each product.` };
    default:
      return { ok: false, reason: 'This code cannot be used.' };
  }
}

/** Apply a discount to a cart. `customerUses` = this customer's earlier orders with the code. */
export function computeDiscount(
  discount: DiscountForEngine | null | undefined,
  lines: CartLine[],
  ctx: { now?: Date; customerUses?: number } = {}
): DiscountResult {
  if (!discount) return { ok: false, code: 'not_found', reason: "This discount code isn't valid." };
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
  const quantity = lines.reduce((s, l) => s + l.quantity, 0);

  // Marked expired because its usage limit was reached: say so (not just "not active")
  const usedUp = Number(discount.maxUses) > 0 && (Number(discount.usesSoFar) || 0) >= Number(discount.maxUses);
  if (discount.status === 'expired') {
    return usedUp
      ? { ok: false, code: 'max_uses', reason: 'This discount code has reached its usage limit.' }
      : { ok: false, code: 'expired', reason: 'This discount code has expired.' };
  }
  const elig = checkDiscountEligibility(discount, { now: ctx.now, subtotal, quantity, customerUses: ctx.customerUses });
  if (!elig.ok) {
    const friendly: Record<string, string> = {
      inactive: "This discount code isn't active.",
      not_started: "This discount code isn't active yet.",
      expired: 'This discount code has expired.',
      max_uses: 'This discount code has reached its usage limit.',
      per_customer: "You've already used this discount code.",
    };
    return { ok: false, code: elig.code, reason: friendly[elig.code] || elig.reason };
  }

  const rules = Array.isArray(discount.rules) ? discount.rules : [];
  if (rules.length) {
    const results = rules.map((r) => ruleMatches(r, lines));
    const pass = discount.ruleMatch === 'any' ? results.some((r) => r.ok) : results.every((r) => r.ok);
    if (!pass) {
      const first = results.find((r) => !r.ok);
      return {
        ok: false,
        code: 'rules',
        reason: discount.ruleMatch === 'any' || !first ? "Your cart doesn't meet the conditions for this code." : first.reason,
      };
    }
  }

  // Excluded products are never discounted (whatever the matching mode)
  const excluded = new Set<string>();
  for (const r of rules) if (r.type === 'excluded_products') for (const p of ids(r.products)) excluded.add(p);
  const base = round2(lines.filter((l) => !excluded.has(l.productId)).reduce((s, l) => s + l.price * l.quantity, 0));
  if (base <= 0) return { ok: false, code: 'rules', reason: "This code doesn't apply to the items in your cart." };

  const value = Math.max(0, Number(discount.value) || 0);
  const amount = discount.type === 'percent' ? round2((base * Math.min(100, value)) / 100) : round2(Math.min(value, base));
  if (amount <= 0) return { ok: false, code: 'zero', reason: "This code doesn't reduce your order." };
  const label = discount.type === 'percent' ? `${round2(Math.min(100, value))}% off` : `${money(value)} off`;
  return { ok: true, amount, base, label };
}

/** Validate rules from the admin form. Returns clean rules or errors. */
export function cleanRules(input: unknown): { rules: Rule[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { rules: [], errors: ['rules must be a list'] };
  if (input.length > 20) return { rules: [], errors: ['at most 20 rules'] };
  const rules: Rule[] = [];
  input.forEach((r: any, i) => {
    const n = i + 1;
    if (!r || !(RULE_TYPES as readonly string[]).includes(r.type)) { errors.push(`rule ${n}: unknown type`); return; }
    const out: Rule = { type: r.type };
    if (['cart_min_quantity', 'max_product_quantity'].includes(r.type)) {
      const q = Number(r.quantity);
      if (!Number.isInteger(q) || q < 1 || q > 10000) errors.push(`rule ${n}: quantity must be a whole number of at least 1`);
      else out.quantity = q;
    }
    if (['cart_total_min', 'cart_total_max'].includes(r.type)) {
      const a = Number(r.amount);
      if (!Number.isFinite(a) || a < 0 || a > 1_000_000) errors.push(`rule ${n}: amount must be 0 or more`);
      else out.amount = round2(a);
    }
    if (['cart_contains_product', 'excluded_products', 'cart_min_quantity'].includes(r.type)) {
      const list = Array.isArray(r.products) ? r.products.map(String) : [];
      if (list.some((p: string) => !/^[0-9a-fA-F]{24}$/.test(p)) || list.length > 200) errors.push(`rule ${n}: invalid products`);
      else if (r.type !== 'cart_min_quantity' && !list.length) errors.push(`rule ${n}: choose at least one product`);
      else out.products = [...new Set(list)];
    }
    rules.push(out);
  });
  return { rules, errors };
}

/** Status shown in the hub: Scheduled / Active / Expired / Disabled. */
export function displayStatus(d: DiscountLike, now = new Date()): 'active' | 'scheduled' | 'expired' | 'disabled' {
  if (d.status === 'disabled') return 'disabled';
  if (d.status === 'expired') return 'expired';
  if (d.activeTo && new Date(d.activeTo).getTime() < now.getTime()) return 'expired';
  const max = Number(d.maxUses) || 0;
  if (max > 0 && (Number(d.usesSoFar) || 0) >= max) return 'expired';
  if (d.activeFrom && new Date(d.activeFrom).getTime() > now.getTime()) return 'scheduled';
  return 'active';
}
