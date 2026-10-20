/**
 * inventory.ts — atomic stock decrements (M-11).
 *
 * Each decrement is a single conditional update, so concurrent orders can never
 * drive stock negative. If the conditional update fails for a 'deny' policy
 * item, the order is flagged as oversold (logged, never thrown).
 */
import mongoose from 'mongoose';
import Product from '../../models/product.model';
import Order from '../../models/order.model';
import { isDenyPolicy } from './checkoutItems';
import { STOCK_ONLY, notifyStockAvailabilityChanged } from '../../utils/storefrontRebuildHooks';
import { lowStockThresholdFor } from '../../utils/lowStock';

/** Order stock writes skip the automatic storefront rebuild (see STOCK_ONLY). */
const STOCK_WRITE = { [STOCK_ONLY]: true } as Record<string, unknown>;


/** An order decrement that took a product/variant from above its low-stock threshold to at/below it, or to 0. */
export interface LowStockCrossing {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName?: string;
  sku?: string;
  before: number;
  after: number;
  threshold: number;
  /** This decrement took the stock to 0 (sold out). */
  soldOut?: boolean;
}

export type DecrementResult =
  | { ok: true; productId: string; variantId: string | null; lowStock?: LowStockCrossing }
  | { ok: false; reason: 'oversold' | 'not_found'; productId?: string; variantId?: string | null };

/** LOW_STOCK_THRESHOLD (.env), or the product's own threshold when customised (utils/lowStock). */
const thresholdOf = (p: any): number => lowStockThresholdFor(p);
/**
 * Alert when this decrement moved the stock from above the threshold to at/below it, or sold it
 * out (> 0 → 0; the decrement only succeeds when stock >= quantity, so before is always > 0).
 * Already-low items therefore alert once more when the last one sells, then stay quiet.
 */
const crossing = (before: number, after: number, threshold: number) =>
  (before > threshold && after <= threshold) || (before > 0 && after <= 0);

function sameId(a: unknown, b: unknown): boolean {
  return a != null && b != null && String(a) === String(b);
}

/** Recompute aggregate stockQuantity / inStock after a variant change. */
async function recomputeAggregate(productId: unknown): Promise<void> {
  await Product.updateOne({ _id: productId, 'variants.0': { $exists: true } }, [
    { $set: { stockQuantity: { $sum: '$variants.stockQty' } } },
    { $set: { inStock: { $gt: ['$stockQuantity', 0] } } },
  ], STOCK_WRITE);
}

/**
 * Atomically decrement stock for a product (and variant, if given).
 * - variant: matches the SAME array element with $elemMatch (`'variants._id'` and
 *   `'variants.stockQty'` as separate conditions could match different elements).
 * - policy 'continue' (variant.inventoryPolicy or product.continueSellingWhenOutOfStock):
 *   a failed conditional update is not an oversell; stock is left at its floor.
 */
export async function decrementStockAtomic(
  productId: unknown,
  variantId: unknown | null,
  quantity: number
): Promise<DecrementResult> {
  const q = Math.max(1, Math.floor(Number(quantity) || 1));
  const pid = String(productId);

  if (variantId) {
    const updated: any = await Product.findOneAndUpdate(
      { _id: productId, variants: { $elemMatch: { _id: variantId, stockQty: { $gte: q } } } },
      { $inc: { 'variants.$.stockQty': -q } },
      { ...STOCK_WRITE, new: true, projection: { variants: 1, name: 1, lowStockThreshold: 1 } }
    ).lean();
    if (updated) {
      await recomputeAggregate(productId);
      // Stock was >= q > 0 before, so reaching 0 means this variant just sold out
      const v = (updated.variants ?? []).find((x: any) => sameId(x._id, variantId));
      if (v && Number(v.stockQty) <= 0) notifyStockAvailabilityChanged(productId);
      const after = Number(v?.stockQty ?? 0), before = after + q, threshold = thresholdOf(updated);
      const lowStock = v && crossing(before, after, threshold)
        ? {
          productId: pid, variantId: String(variantId), productName: updated.name,
          // variant name only when the product has several (single variants are often "Default Title")
          variantName: (updated.variants?.length ?? 0) > 1 ? (v.name || v.title || undefined) : undefined,
          sku: v.sku, before, after, threshold, soldOut: after <= 0,
        }
        : undefined;
      return { ok: true, productId: pid, variantId: String(variantId), ...(lowStock ? { lowStock } : {}) };
    }
    const product = await Product.findById(productId).select('variants inventoryPolicy continueSellingWhenOutOfStock').lean();
    const variant = (product as any)?.variants?.find((v: any) => sameId(v._id, variantId));
    if (!product || !variant) return { ok: false, reason: 'not_found', productId: pid, variantId: String(variantId) };
    if (!isDenyPolicy(product, variant)) {
      return { ok: true, productId: pid, variantId: String(variantId) };
    }
    return { ok: false, reason: 'oversold', productId: pid, variantId: String(variantId) };
  }

  const updated: any = await Product.findOneAndUpdate(
    { _id: productId, stockQuantity: { $gte: q } },
    [
      { $set: { stockQuantity: { $subtract: ['$stockQuantity', q] } } },
      { $set: { inStock: { $gt: ['$stockQuantity', 0] } } },
    ],
    { ...STOCK_WRITE, new: true, projection: { stockQuantity: 1, name: 1, sku: 1, lowStockThreshold: 1 } }
  ).lean();
  if (updated) {
    if (Number(updated.stockQuantity) <= 0) notifyStockAvailabilityChanged(productId);
    const after = Number(updated.stockQuantity ?? 0), before = after + q, threshold = thresholdOf(updated);
    const lowStock = crossing(before, after, threshold)
      ? { productId: pid, variantId: null, productName: updated.name, sku: updated.sku, before, after, threshold, soldOut: after <= 0 }
      : undefined;
    return { ok: true, productId: pid, variantId: null, ...(lowStock ? { lowStock } : {}) };
  }
  const product = await Product.findById(productId).select('inventoryPolicy continueSellingWhenOutOfStock').lean();
  if (!product) return { ok: false, reason: 'not_found', productId: pid, variantId: null };
  if (!isDenyPolicy(product, null)) {
    return { ok: true, productId: pid, variantId: null };
  }
  return { ok: false, reason: 'oversold', productId: pid, variantId: null };
}

export async function recordOversell(
  orderId: unknown,
  entry: { product?: unknown; variant?: unknown | null; sku?: string; quantity: number }
): Promise<void> {
  console.warn(
    `[Inventory] OVERSELL order=${orderId} product=${entry.product ?? '-'} variant=${entry.variant ?? '-'} sku=${entry.sku ?? '-'} qty=${entry.quantity}`
  );
  await Order.updateOne(
    { _id: orderId },
    {
      $set: { oversold: true },
      $push: {
        oversells: {
          $each: [{
            product: entry.product ? new mongoose.Types.ObjectId(String(entry.product)) : undefined,
            variant: entry.variant ? new mongoose.Types.ObjectId(String(entry.variant)) : null,
            sku: entry.sku,
            quantity: entry.quantity,
            at: new Date(),
          }],
          $slice: -50,
        },
      },
    }
  );
}

/** Decrement one line and flag the order on oversell. Never throws for stock shortfalls. */
export async function decrementLineForOrder(
  orderId: unknown,
  line: { product: unknown; variant?: unknown | null; quantity: number; sku?: string }
): Promise<DecrementResult> {
  const result = await decrementStockAtomic(line.product, line.variant ?? null, line.quantity);
  if (!result.ok && result.reason === 'oversold') {
    await recordOversell(orderId, { product: line.product, variant: line.variant ?? null, sku: line.sku, quantity: line.quantity });
  } else if (!result.ok) {
    console.warn(`[Inventory] Product/variant not found for order=${orderId} product=${line.product} variant=${line.variant ?? '-'}`);
  }
  return result;
}

/**
 * Resolve a Tagada line item (sku / tagadaVariantId only) to a product+variant.
 * Used for legacy orders that have no resolved `products[]`.
 */
async function resolveBySkuOrTagadaVariant(sku?: string, tagadaVariantId?: string) {
  const or: any[] = [];
  if (tagadaVariantId) or.push({ 'variants.tagadaVariantId': tagadaVariantId }, { tagadaVariantId });
  if (sku) or.push({ 'variants.sku': sku }, { sku });
  if (!or.length) return null;
  const product: any = await Product.findOne({ $or: or }).select('variants sku tagadaVariantId').lean();
  if (!product) return null;
  const variant = (product.variants ?? []).find(
    (v: any) => (tagadaVariantId && v.tagadaVariantId === tagadaVariantId) || (sku && v.sku === sku)
  );
  return { productId: product._id, variantId: variant?._id ?? null };
}

/**
 * Decrement inventory for every line of a paid order. Prefers the
 * server-resolved `products[]` (with variant); falls back to Tagada `lineItems`.
 */
export async function decrementInventoryForOrder(order: any): Promise<{ decremented: number; oversold: number; lowStock: LowStockCrossing[] }> {
  let decremented = 0;
  let oversold = 0;
  const lowStock: LowStockCrossing[] = [];
  const lines: Array<{ product: unknown; variant: unknown | null; quantity: number; sku?: string }> = [];

  const products = Array.isArray(order.products) ? order.products.filter((p: any) => p?.product) : [];
  if (products.length) {
    for (const p of products) {
      lines.push({ product: p.product?._id ?? p.product, variant: p.variant ?? null, quantity: p.quantity || 1, sku: p.sku });
    }
  } else if (Array.isArray(order.lineItems)) {
    for (const li of order.lineItems) {
      const resolved = await resolveBySkuOrTagadaVariant(li.sku, li.tagadaVariantId);
      if (!resolved) {
        console.warn(`[Inventory] No product for line sku=${li.sku ?? '-'} on order ${order._id}`);
        continue;
      }
      lines.push({ product: resolved.productId, variant: resolved.variantId, quantity: li.quantity || 1, sku: li.sku });
    }
  }

  for (const line of lines) {
    const r = await decrementLineForOrder(order._id, line);
    if (r.ok) {
      decremented++;
      if (r.lowStock) lowStock.push(r.lowStock);
    } else if (r.reason === 'oversold') oversold++;
  }
  return { decremented, oversold, lowStock };
}
