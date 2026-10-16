import { Request, Response } from 'express';
import { normalizePath, queryOf, withQuery } from '../utils/redirectPaths';
import { resolvePath, countHit } from '../services/redirectResolver';

/**
 * GET /api/redirects/resolve
 *
 * nginx mode (X-Original-URI header, sent by the storefront's @resolve fallback for URLs that
 * have no prerendered file):
 *   - active redirect          → 301 Location: /new-path?original-query   (Cache-Control 1 h)
 *   - live item, not prerendered yet → 200 + X-Accel-Redirect: /200.html (nginx serves the app)
 *   - nothing                  → 404 (nginx shows its noindex 404 page)
 * JSON mode (?path=/products/x&format=json — used by the app for in-site links):
 *   { found: true, to, statusCode } | { found: false, live: true } | 404 { found: false }
 * Any error answers like "nothing" (a normal 404), never a 500 page.
 */
export const resolveRedirect = async (req: Request, res: Response): Promise<void> => {
  const header = req.headers['x-original-uri'];
  const json = req.query.format === 'json' || typeof header !== 'string';
  const raw = json ? (typeof req.query.path === 'string' ? req.query.path : '') : (header as string);
  const notFound = () => {
    if (json) res.status(404).json({ found: false });
    else res.status(404).end();
  };

  const path = normalizePath(raw);
  if (!path) return notFound();
  try {
    const r = await resolvePath(path);
    if (r.type === 'redirect') {
      countHit(r.id);
      const target = withQuery(r.to, queryOf(raw));
      if (json) {
        res.status(200).json({ found: true, to: target, statusCode: r.statusCode });
        return;
      }
      // Browsers cache a 301 forever without this; 1 h lets a corrected redirect take effect
      res.set('Cache-Control', 'public, max-age=3600');
      res.redirect(r.statusCode, target);
      return;
    }
    if (r.type === 'live') {
      if (json) {
        res.status(200).json({ found: false, live: true });
        return;
      }
      res.set('X-Accel-Redirect', '/200.html');
      res.status(200).end();
      return;
    }
    notFound();
  } catch (err) {
    console.error('[Redirects] resolve failed:', (err as Error)?.message ?? err);
    notFound();
  }
};
