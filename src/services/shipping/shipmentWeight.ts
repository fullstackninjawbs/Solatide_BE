import Product from '../../models/product.model';

/** A single unit above this is a data-entry mistake (Australia Post's parcel limit is 22 kg). */
export const MAX_UNIT_GRAMS = 22_000;
/** Used for a unit whose product/variant weight is missing or invalid (override with env). */
export const fallbackUnitGrams = (): number => {
  const v = Number(process.env.SHIPPING_FALLBACK_ITEM_GRAMS);
  return Number.isFinite(v) && v > 0 && v <= MAX_UNIT_GRAMS ? v : 100;
};
/** Used when an order has no lines at all (previous behaviour). */
export const EMPTY_ORDER_GRAMS = 500;

export interface ShipmentLine {
  description: string;
  sku: string;
  quantity: number;
  unitGrams: number;
  /** Unit price (customs/declared value) */
  value: number;
}

export interface ShipmentWeight {
  lines: ShipmentLine[];
  itemsGrams: number;
  /** Products whose weight was missing/invalid and replaced by the fallback */
  warnings: string[];
}

const validGrams = (g: unknown): g is number => typeof g === 'number' && Number.isFinite(g) && g > 0 && g <= MAX_UNIT_GRAMS;
const sameId = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);

/**
 * Weight of an order's contents, per line and in total. Lines come from the server-resolved
 * `products[]` (product + variant ids) when present, otherwise from Tagada `lineItems` (sku).
 * Each unit uses its variant's weightGrams (else the product's first variant / root weight);
 * a missing or absurd weight is replaced by the fallback and reported in `warnings`.
 */
export async function computeShipmentWeight(order: any): Promise<ShipmentWeight> {
  const raw: Array<{ productId?: unknown; variantId?: unknown; sku?: string; title?: string; quantity: number; price: number }> = [];
  const products = Array.isArray(order?.products) ? order.products.filter((p: any) => p?.product) : [];
  if (products.length) {
    for (const p of products) {
      raw.push({
        productId: p.product?._id ?? p.product,
        variantId: p.variant ?? null,
        sku: p.sku,
        title: p.title,
        quantity: Math.max(1, Math.floor(Number(p.quantity) || 1)),
        price: Number(p.price) || 0,
      });
    }
  } else if (Array.isArray(order?.lineItems)) {
    for (const li of order.lineItems) {
      raw.push({
        sku: li.sku,
        title: li.title,
        quantity: Math.max(1, Math.floor(Number(li.quantity) || 1)),
        price: Number(li.unitPrice ?? li.price) || 0,
      });
    }
  }

  if (!raw.length) {
    return { lines: [], itemsGrams: EMPTY_ORDER_GRAMS, warnings: ['Order has no items: used a default weight of 500 g'] };
  }

  const fallback = fallbackUnitGrams();
  const lines: ShipmentLine[] = [];
  const warnings: string[] = [];

  for (const r of raw) {
    let product: any = null;
    if (r.productId) product = await Product.findById(r.productId).select('name sku variants weightGrams').lean();
    if (!product && r.sku) product = await Product.findOne({ $or: [{ 'variants.sku': r.sku }, { sku: r.sku }] }).select('name sku variants weightGrams').lean();

    const variants: any[] = product?.variants ?? [];
    const variant =
      (r.variantId && variants.find((v) => sameId(v._id, r.variantId))) ||
      (r.sku && variants.find((v) => v.sku === r.sku)) ||
      (variants.length === 1 ? variants[0] : null);

    const candidate = variant?.weightGrams ?? product?.weightGrams;
    const name = r.title || product?.name || r.sku || 'Unknown item';
    let unitGrams: number;
    if (validGrams(candidate)) {
      unitGrams = candidate;
    } else {
      unitGrams = fallback;
      warnings.push(
        candidate == null || candidate === 0
          ? `"${name}" has no weight set: used ${fallback} g per unit`
          : `"${name}" has an invalid weight (${candidate} g): used ${fallback} g per unit — please correct it in the product`
      );
    }
    lines.push({ description: name, sku: r.sku || variant?.sku || product?.sku || 'UNKNOWN', quantity: r.quantity, unitGrams, value: r.price });
  }

  const itemsGrams = lines.reduce((sum, l) => sum + l.unitGrams * l.quantity, 0);
  return { lines, itemsGrams, warnings };
}

/** Empty-package weight in grams from a ShippingPackage (value + unit); 0 when not set. */
export function packageTareGrams(pkg: any): number {
  const value = Number(pkg?.weight?.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const grams = pkg?.weight?.unit === 'kg' ? value * 1000 : value;
  return grams <= MAX_UNIT_GRAMS ? grams : 0;
}
