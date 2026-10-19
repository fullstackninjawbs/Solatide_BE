/**
 * Low-stock threshold rules, shared by the order alert email, its "all low items" table and the
 * admin dashboard widget.
 *
 * - LOW_STOCK_THRESHOLD (.env) is the store-wide threshold (default 5).
 * - A product's own "Low stock threshold" overrides it only when it was changed from the form's
 *   old default of 5 (every product saved through the form stores 5, so 5 means "not customised").
 */
export const LEGACY_PRODUCT_DEFAULT = 5;

export function globalLowStockThreshold(): number {
  const v = Number(process.env.LOW_STOCK_THRESHOLD);
  return Number.isInteger(v) && v >= 0 ? v : LEGACY_PRODUCT_DEFAULT;
}

/** Effective threshold for a product (lean doc or anything with lowStockThreshold). */
export function lowStockThresholdFor(product: { lowStockThreshold?: unknown } | null | undefined): number {
  const own = Number(product?.lowStockThreshold);
  if (Number.isFinite(own) && own >= 0 && own !== LEGACY_PRODUCT_DEFAULT) return own;
  return globalLowStockThreshold();
}
