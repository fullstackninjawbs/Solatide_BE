import type { RedirectEntityKind } from '../models/redirect.model';

const MAX_PATH = 500;

/**
 * Normalise a request path for redirect matching: path only (no query/hash), decoded once,
 * lower-case, single slashes, no trailing slash (except "/"). Returns null if unusable.
 *   "/Products/Old%20Name/?utm=x" → "/products/old name"
 */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.split('#')[0].split('?')[0].trim();
  if (!p) return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    // malformed escapes: keep as-is
  }
  if (/[\r\n\0]/.test(p)) return null;
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/').toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.length > MAX_PATH ? null : p;
}

/** The query string part of a raw request URI ("" when none), e.g. "?utm_source=x". */
export function queryOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const i = raw.indexOf('?');
  if (i < 0) return '';
  const q = raw.slice(i).split('#')[0];
  return q.length > 1 && !/[\r\n\0]/.test(q) ? q : '';
}

/** Paths that are never the source or target of a redirect (app routes, assets, the API). */
const PROTECTED_PREFIXES = ['/admin', '/api', '/checkout', '/account', '/order', '/orders', '/review', '/assets'];
export function isProtectedPath(path: string): boolean {
  if (path === '/' || path === '/collections/all') return true;
  return PROTECTED_PREFIXES.some((pre) => path === pre || path.startsWith(pre + '/'));
}

/**
 * A redirect target must be an internal path: starts with a single "/", no scheme/host, no
 * backslashes, whitespace or control characters — so a redirect can never send visitors off-site.
 */
export function isValidInternalTarget(target: unknown): target is string {
  return typeof target === 'string'
    && target.length > 0 && target.length <= MAX_PATH
    && target.startsWith('/') && !target.startsWith('//')
    && !/[\\\s\0]/.test(target)
    && !/^\/[^/]*:/.test(target);
}

/** Storefront path of an item by kind + slug. */
export function pathFor(kind: RedirectEntityKind, slug: string): string {
  const base = kind === 'product' ? '/products/' : kind === 'collection' ? '/collections/' : '/pages/';
  return base + String(slug).toLowerCase();
}

/** Append a request's query string to a target that may already have one. */
export function withQuery(target: string, query: string): string {
  if (!query) return target;
  return target.includes('?') ? `${target}&${query.slice(1)}` : `${target}${query}`;
}
