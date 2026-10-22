/**
 * checkoutItems.ts — server-side resolution of checkout lines (M-11).
 * Client sends {productId, variantId?, tagadaVariantId?, quantity}; price,
 * variant and Tagada variant id are resolved from the database only.
 */
export const MAX_LINE_QUANTITY = 100;
export const MAX_LINES = 50;

export interface CheckoutLineInput {
  productId?: unknown;
  product?: unknown;
  variantId?: unknown;
  tagadaVariantId?: unknown;
  quantity?: unknown;
}

export interface ResolvedLine {
  product: any; // ObjectId
  variant: any | null;
  quantity: number;
  price: number;
  /** '' when not required (bank transfer checkout) and the product has none */
  tagadaVariantId: string;
  sku?: string;
  title?: string;
  variantTitle?: string;
}

export class CheckoutValidationError extends Error {
  statusCode = 400;
}

export function parseQuantity(q: unknown): number {
  const n = typeof q === 'string' && q.trim() !== '' ? Number(q) : q;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_LINE_QUANTITY) {
    throw new CheckoutValidationError(`Quantity must be an integer between 1 and ${MAX_LINE_QUANTITY}.`);
  }
  return n;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : v != null && typeof v === 'object' && 'toString' in (v as any) ? String(v) : undefined;
}

export function resolveVariant(product: any, variantId?: string, tagadaVariantId?: string): any | null {
  const variants: any[] = Array.isArray(product?.variants) ? product.variants : [];
  if (variants.length === 0) return null;
  let v = variantId ? variants.find((x) => String(x._id) === variantId || x.tagadaVariantId === variantId) : undefined;
  if (!v && tagadaVariantId) v = variants.find((x) => x.tagadaVariantId === tagadaVariantId);
  if (!v && !variantId && !tagadaVariantId && variants.length === 1) v = variants[0];
  if (!v) {
    throw new CheckoutValidationError(
      variantId || tagadaVariantId
        ? `Selected variant was not found for '${product.name}'.`
        : `Please select a variant for '${product.name}'.`
    );
  }
  return v;
}

/**
 * Backorder rule — must match the storefront (ProductDetail isAvailable / schema availability):
 * selling continues past zero stock if the product OR the selected variant allows it.
 */
export function isDenyPolicy(product: any, variant: any | null): boolean {
  if (product?.continueSellingWhenOutOfStock === true || product?.inventoryPolicy === 'continue') return false;
  if (variant && (variant.continueSellingWhenOutOfStock === true || variant.inventoryPolicy === 'continue')) return false;
  return true;
}

export async function resolveCheckoutLines(
  inputs: CheckoutLineInput[],
  loadProduct: (id: string) => Promise<any | null>,
  /** Tagada checkout needs a Tagada variant id per line; our own bank transfer checkout does not. */
  opts: { requireTagadaVariant?: boolean } = {}
): Promise<ResolvedLine[]> {
  const requireTagadaVariant = opts.requireTagadaVariant !== false;
  if (!Array.isArray(inputs) || inputs.length === 0) throw new CheckoutValidationError('At least one item is required.');
  if (inputs.length > MAX_LINES) throw new CheckoutValidationError(`At most ${MAX_LINES} lines per order.`);

  const out: ResolvedLine[] = [];
  const requested = new Map<string, number>(); // stock check across duplicate lines
  for (const input of inputs) {
    const productId = str(input.productId ?? input.product);
    if (!productId || !/^[0-9a-fA-F]{24}$/.test(productId)) throw new CheckoutValidationError('An item in your cart is no longer available. Please remove it from your cart and try again.');
    const quantity = parseQuantity(input.quantity ?? 1);
    const product = await loadProduct(productId);
    if (!product || product.publishStatus === 'draft' || product.publishStatus === 'archived') {
      throw new CheckoutValidationError('An item in your cart is no longer available. Please remove it from your cart and try again.');
    }
    const variant = resolveVariant(product, str(input.variantId), str(input.tagadaVariantId));
    const price = Number(variant ? variant.price : product.price);
    if (!Number.isFinite(price) || price < 0) throw new CheckoutValidationError(`Product '${product.name}' has no valid price.`);

    const tagadaVariantId = variant?.tagadaVariantId || (!variant ? product.tagadaVariantId : undefined);
    if (!tagadaVariantId && requireTagadaVariant) {
      throw new CheckoutValidationError(`'${product.name}' is not configured for checkout (missing Tagada variant id).`);
    }

    if (isDenyPolicy(product, variant)) {
      const key = `${productId}:${variant?._id ?? '-'}`;
      const total = (requested.get(key) ?? 0) + quantity;
      requested.set(key, total);
      const stock = Number(variant ? variant.stockQty : product.stockQuantity) || 0;
      if (total > stock) {
        throw new CheckoutValidationError(
          stock <= 0 ? `'${product.name}' is out of stock.` : `Only ${stock} units of '${product.name}' are available.`
        );
      }
    }

    out.push({
      product: product._id,
      variant: variant?._id ?? null,
      quantity,
      price,
      tagadaVariantId: tagadaVariantId ? String(tagadaVariantId) : '',
      sku: variant?.sku || product.sku || undefined,
      title: product.name,
      variantTitle: variant?.title,
    });
  }
  return out;
}
