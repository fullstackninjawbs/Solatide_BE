import type { Schema } from 'mongoose';
import { triggerStorefrontRebuild } from './rebuildStorefront';
import { cacheDel, cacheDelIndexed, isRedisConnected } from './cache';

/**
 * Request a (debounced, single-flight) storefront rebuild whenever a document that is
 * rendered into the prerendered HTML / JSON-LD actually changes — no matter which code path
 * wrote it: admin edits, CSV import, Tagada sync, batch/COA updates. Order stock decrements
 * only rebuild when a product/variant runs out (see STOCK_ONLY below).
 *
 * Bursts (e.g. a multi-line order or a full import) collapse into one rebuild via the
 * 10 s debounce + cross-process lock in rebuildStorefront.ts. No-op updates are ignored.
 *
 * Active ONLY inside the running API server (server.ts calls enableStorefrontAutoRebuild()).
 * Standalone scripts, migrations and tests that load these models never open Redis
 * connections or start deploys.
 */
let enabled = false;
export function enableStorefrontAutoRebuild(): void {
  enabled = true;
}

const QUERY_WRITES = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
] as const;

const changed = (res: any): boolean => {
  if (!res) return false;
  if (typeof res.deletedCount === 'number') return res.deletedCount > 0;
  if (typeof res.modifiedCount === 'number' || typeof res.upsertedCount === 'number') {
    return (res.modifiedCount ?? 0) > 0 || (res.upsertedCount ?? 0) > 0;
  }
  return true; // findOneAndUpdate returns the document when one matched
};

/**
 * Also clears the Redis API cache (cache keys only — never database data), so both the
 * storefront API and the rebuilt prerendered HTML show current price/stock instead of a value
 * cached for up to 10 minutes (order decrements and Tagada sync did not invalidate it before).
 */
const onChange = () => {
  if (!enabled) return;
  if (isRedisConnected()) {
    Promise.all([cacheDel('products:detail*'), cacheDel('products:list*'), cacheDel('public:*')]).catch(() => undefined);
  }
  triggerStorefrontRebuild();
};

/** Product ids touched by a write: from the returned doc, or the query's _id filter. null = unknown. */
const productIdsFromWrite = (query: any, res: any): string[] | null => {
  if (res && res._id) return [String(res._id)];
  const id = query && typeof query.getFilter === 'function' ? query.getFilter()?._id : undefined;
  if (!id) return null;
  if (Array.isArray(id?.$in)) return id.$in.map(String);
  if (typeof id === 'string' || (typeof id === 'object' && typeof id.toHexString === 'function')) return [String(id)];
  return null;
};

/**
 * Product writes (orders decrement stock several times a day) clear only that product's cached
 * detail entries + the product lists, instead of every product's detail. Unknown targets
 * (e.g. updateMany without an _id filter) fall back to clearing all product details.
 * `contentEdit` (admin-style save / findOneAndUpdate) also refreshes the public COA list, which
 * shows product names; plain stock updates do not.
 */
const onProductChange = (ids: string[] | null, contentEdit: boolean) => {
  if (!enabled) return;
  if (isRedisConnected()) {
    const jobs: Promise<unknown>[] = [cacheDel('products:list*')];
    if (ids && ids.length) ids.forEach((id) => jobs.push(cacheDelIndexed(`products:detail-index:${id}`)));
    else jobs.push(cacheDel('products:detail*'));
    if (contentEdit) jobs.push(cacheDel('public:coas'));
    Promise.all(jobs).catch(() => undefined);
  }
  triggerStorefrontRebuild();
};

const CONTENT_EDIT_OPS = new Set(['findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'deleteOne', 'deleteMany']);

/**
 * Query option for order stock decrements: `Product.updateOne(filter, update, { stockOnly: true })`.
 * Such writes only clear that product's API cache — the product page fetches live stock anyway —
 * and do NOT rebuild the storefront. The caller rebuilds via notifyStockAvailabilityChanged()
 * only when a product/variant actually runs out (the prerendered "Sold out" + schema.org
 * availability change). Admin edits, imports and Tagada sync are not tagged and rebuild as before.
 */
export const STOCK_ONLY = 'stockOnly';
const isStockOnly = (query: any): boolean => !!(query && typeof query.getOptions === 'function' && query.getOptions()?.[STOCK_ONLY]);

const clearProductCache = (ids: string[] | null) => {
  if (!enabled || !isRedisConnected()) return;
  const jobs: Promise<unknown>[] = [cacheDel('products:list*')];
  if (ids && ids.length) ids.forEach((id) => jobs.push(cacheDelIndexed(`products:detail-index:${id}`)));
  else jobs.push(cacheDel('products:detail*'));
  Promise.all(jobs).catch(() => undefined);
};

/** A stock write made a product or variant run out (or come back): rebuild the storefront. */
export function notifyStockAvailabilityChanged(productId: unknown): void {
  onProductChange(productId ? [String(productId)] : null, false);
}

export function registerStorefrontRebuildHooks(schema: Schema, opts: { product?: boolean } = {}): void {
  if (opts.product) {
    schema.post('save', function (doc: any) { onProductChange(doc?._id ? [String(doc._id)] : null, true); });
    schema.post('insertMany', function () { onProductChange([], true); }); // new products: lists only
    for (const op of QUERY_WRITES) {
      schema.post(op as any, function (this: any, res: any) {
        if (!changed(res)) return;
        if (isStockOnly(this)) clearProductCache(productIdsFromWrite(this, res));
        else onProductChange(productIdsFromWrite(this, res), CONTENT_EDIT_OPS.has(op));
      });
    }
    return;
  }
  schema.post('save', onChange);
  schema.post('insertMany', onChange);
  for (const op of QUERY_WRITES) {
    schema.post(op as any, function (res: any) {
      if (changed(res)) onChange();
    });
  }
}
