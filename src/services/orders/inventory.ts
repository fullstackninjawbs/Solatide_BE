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

export type DecrementResult =
  | { ok: true; productId: string; variantId: string | null }
  | { ok: false; reason: 'oversold' | 'not_found'; productId?: string; variantId?: string | null };

function sameId(a: unknown, b: unknown): boolean {
  return a != null && b != null && String(a) === String(b);
}

/** Recompute aggregate stockQuantity / inStock after a variant change. */
async function recomputeAggregate(productId: unknown): Promise<void> {
  await Product.updateOne({ _id: productId, 'variants.0': { $exists: true } }, [
    { $set: { stockQuantity: { $sum: '$variants.stockQty' } } },
    { $set: { inStock: { $gt: ['$stockQuantity', 0] } } },
  ]);
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
    const res = await Product.updateOne(
      { _id: productId, variants: { $elemMatch: { _id: variantId, stockQty: { $gte: q } } } },
      { $inc: { 'variants.$.stockQty': -q } }
    );
    if (res.modifiedCount === 1) {
      await recomputeAggregate(productId);
      return { ok: true, productId: pid, variantId: String(variantId) };
    }
    const product = await Product.findById(productId).select('variants inventoryPolicy continueSellingWhenOutOfStock').lean();
    const variant = (product as any)?.variants?.find((v: any) => sameId(v._id, variantId));
    if (!product || !variant) return { ok: false, reason: 'not_found', productId: pid, variantId: String(variantId) };
    if (!isDenyPolicy(product, variant)) {
      return { ok: true, productId: pid, variantId: String(variantId) };
    }
    return { ok: false, reason: 'oversold', productId: pid, variantId: String(variantId) };
  }

  const res = await Product.updateOne(
    { _id: productId, stockQuantity: { $gte: q } },
    [
      { $set: { stockQuantity: { $subtract: ['$stockQuantity', q] } } },
      { $set: { inStock: { $gt: ['$stockQuantity', 0] } } },
    ]
  );
  if (res.modifiedCount === 1) return { ok: true, productId: pid, variantId: null };
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
export async function decrementInventoryForOrder(order: any): Promise<{ decremented: number; oversold: number }> {
  let decremented = 0;
  let oversold = 0;
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
    if (r.ok) decremented++;
    else if (r.reason === 'oversold') oversold++;
  }
  return { decremented, oversold };
}
