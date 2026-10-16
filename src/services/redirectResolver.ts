import Redirect from '../models/redirect.model';
import Product from '../models/product.model';
import Collection from '../models/collection.model';
import Page from '../models/Page';
import { cacheGet, cacheSet } from '../utils/cache';
import { isProtectedPath, isValidInternalTarget } from '../utils/redirectPaths';

export type Resolution =
  | { type: 'redirect'; to: string; statusCode: 301 | 302; id: string }
  | { type: 'live' }
  | { type: 'none' };

const REDIRECT_TTL = 10 * 60; // seconds; every redirect change clears redirects:*
const OTHER_TTL = 60;         // "live" / "nothing here" — short, so new pages and bot probes stay cheap

/**
 * Is this path a live storefront item that simply has no prerendered file yet (created/renamed,
 * storefront rebuild still running)? Then nginx should serve the app shell with 200, not a 404.
 */
export async function isLiveItem(path: string): Promise<boolean> {
  const m = path.match(/^\/(products|collections|pages)\/([a-z0-9-]+)$/);
  if (!m) return false;
  const [, type, slug] = m;
  if (type === 'products') return !!(await Product.exists({ slug, publishStatus: 'active' }));
  if (type === 'collections') return !!(await Collection.exists({ slug, status: 'active' }));
  return !!(await Page.exists({ slug, status: 'published' }));
}

export type TargetStatus = 'live' | 'not_public' | 'missing' | 'other';

/**
 * Where a redirect target leads, for admin warnings: a live storefront item, an item that exists
 * but is not public (draft/archived/inactive — visitors would get a 404), no such item, or a
 * path that is not a product/collection/page (e.g. "/", "/collections/all").
 */
export async function targetStatus(toPath: string): Promise<TargetStatus> {
  const path = toPath.split('?')[0].toLowerCase();
  if (path === '/collections/all') return 'live'; // the shop page always exists
  const m = path.match(/^\/(products|collections|pages)\/([a-z0-9-]+)$/);
  if (!m) return 'other';
  if (await isLiveItem(path)) return 'live';
  const [, type, slug] = m;
  const exists = type === 'products' ? await Product.exists({ slug })
    : type === 'collections' ? await Collection.exists({ slug })
    : await Page.exists({ slug });
  return exists ? 'not_public' : 'missing';
}

/** Answer for a normalised path (see utils/redirectPaths.normalizePath), cached in Redis. */
export async function resolvePath(path: string): Promise<Resolution> {
  const key = `redirects:resolve:${path}`;
  const cached = await cacheGet<Resolution>(key);
  if (cached) return cached;

  let result: Resolution = { type: 'none' };
  if (!isProtectedPath(path)) {
    const r: any = await Redirect.findOne({ active: true, fromPath: path }).select('toPath statusCode').lean();
    if (r && isValidInternalTarget(r.toPath)) {
      result = { type: 'redirect', to: r.toPath, statusCode: r.statusCode === 302 ? 302 : 301, id: String(r._id) };
    } else if (await isLiveItem(path)) {
      result = { type: 'live' };
    }
  }
  await cacheSet(key, result, result.type === 'redirect' ? REDIRECT_TTL : OTHER_TTL);
  return result;
}

/** Count a redirect hit (fire-and-forget; never delays the response). */
export function countHit(id: string): void {
  Redirect.updateOne({ _id: id }, { $inc: { hits: 1 }, $set: { lastHitAt: new Date() } }).catch(() => undefined);
}
