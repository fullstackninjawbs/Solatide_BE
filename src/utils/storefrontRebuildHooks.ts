import type { Schema } from 'mongoose';
import { triggerStorefrontRebuild } from './rebuildStorefront';
import { cacheDel, isRedisConnected } from './cache';

/**
 * Request a (debounced, single-flight) storefront rebuild whenever a document that is
 * rendered into the prerendered HTML / JSON-LD actually changes — no matter which code path
 * wrote it: admin edits, order stock decrements, CSV import, Tagada sync, batch/COA updates.
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

const QUERY_WRITES = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'] as const;

const changed = (res: any): boolean => {
  if (!res) return false;
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
    Promise.all([cacheDel('products:detail*'), cacheDel('products:list*')]).catch(() => undefined);
  }
  triggerStorefrontRebuild();
};

export function registerStorefrontRebuildHooks(schema: Schema): void {
  schema.post('save', onChange);
  schema.post('insertMany', onChange);
  for (const op of QUERY_WRITES) {
    schema.post(op as any, function (res: any) {
      if (changed(res)) onChange();
    });
  }
}
