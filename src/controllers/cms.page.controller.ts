import { Request, Response, NextFunction } from 'express';
import { cacheGet, cacheSet, cacheDel, TTL } from '../utils/cache';
import Page from '../models/Page';
import { triggerStorefrontRebuild } from '../utils/rebuildStorefront';
import { sanitizeRichHtml } from '../utils/sanitizeHtml';
import { escapeRegex } from '../utils/collectionUtils';
import { isDbUnavailableError } from '../middleware/errorHandler';

const reservedHandles = [
  'admin', 'product', 'products', 'cart', 'checkout', 'login',
  'register', 'account', 'search', 'collections', 'page', 'api'
];

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 150;

/** Trim + lowercase; returns null when the slug is not a valid URL handle. */
export const normalizeSlug = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  if (!slug || slug.length > SLUG_MAX || !SLUG_RE.test(slug)) return null;
  return slug;
};

const INVALID_SLUG_MESSAGE =
  'URL handle must be lowercase letters, numbers and single hyphens (e.g. "my-page"), max 150 characters.';

/** True if another page already uses `slug` as its slug or in its slug history. */
const slugTakenByOtherPage = async (slug: string, excludeId?: unknown): Promise<boolean> => {
  const filter: any = { $or: [{ slug }, { slugHistory: slug }] };
  if (excludeId) filter._id = { $ne: excludeId };
  const other = await Page.findOne(filter).select('_id');
  return !!other;
};

const optString = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

/** Fields the storefront (DynamicPage.jsx / prerender) needs from a public page. */
const toPublicPage = (page: any) => ({
  _id: page._id,
  title: page.title,
  slug: page.slug,
  content: { html: page.content?.html || '' },
  seoTitle: page.seoTitle,
  metaDescription: page.metaDescription,
  status: page.status,
  publishedAt: page.publishedAt,
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
});

/**
 * ADMIN: Get all pages
 */
export const getAllPages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const query: any = {};

    if (search) {
      const safe = escapeRegex(search);
      query.$or = [
        { title: { $regex: safe, $options: 'i' } },
        { slug: { $regex: safe, $options: 'i' } }
      ];
    }
    if (status && status !== 'all') {
      query.status = status;
    }

    // The list only shows these columns: never send each page's full HTML content
    const LIST_FIELDS = 'title slug status updatedAt publishedAt createdAt';

    // Legacy shape (plain array) when no paging is requested
    if (req.query.page === undefined && req.query.limit === undefined) {
      const pages = await Page.find(query).select(LIST_FIELDS).sort({ updatedAt: -1 }).lean();
      res.json(pages);
      return;
    }

    const page = Math.min(10000, Math.max(1, parseInt(String(req.query.page), 10) || 1));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 25));
    const [total, pages] = await Promise.all([
      Page.countDocuments(query),
      Page.find(query)
        .select(LIST_FIELDS)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    res.json({ success: true, data: { pages }, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

/**
 * ADMIN: Get single page by ID
 */
export const getPageById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = await Page.findById(req.params.id);
    if (!page) {
      res.status(404).json({ message: 'Page not found' });
      return;
    }
    res.json(page);
  } catch (error) {
    next(error);
  }
};

/**
 * ADMIN: Create new page
 */
export const createPage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, content, seoTitle, metaDescription, status } = req.body || {};

    if (typeof title !== 'string' || !title.trim() || req.body?.slug === undefined) {
      res.status(400).json({ message: 'Title and URL handle are required.' });
      return;
    }

    const slug = normalizeSlug(req.body.slug);
    if (!slug) {
      res.status(400).json({ message: INVALID_SLUG_MESSAGE });
      return;
    }

    if (reservedHandles.includes(slug)) {
      res.status(400).json({ message: 'This URL handle is reserved and cannot be used.' });
      return;
    }

    if (await slugTakenByOtherPage(slug)) {
      res.status(400).json({ message: 'This URL handle is already in use.' });
      return;
    }

    const sanitizedHtml = sanitizeRichHtml(content?.html);
    const pageStatus = status === 'published' ? 'published' : 'draft';

    const newPage = new Page({
      title: title.trim(),
      slug,
      content: {
        html: sanitizedHtml,
        json: content?.json || null
      },
      seoTitle: optString(seoTitle, 300),
      metaDescription: optString(metaDescription, 500),
      status: pageStatus,
      publishedAt: pageStatus === 'published' ? new Date() : null,
      createdBy: (req as any).user?._id
    });

    await newPage.save();

    // Public page caches (list + by slug) must not serve the old version
    await cacheDel('public:page*');
    // Trigger storefront rebuild automatically in the background
    triggerStorefrontRebuild();

    res.status(201).json(newPage);
  } catch (error) {
    next(error);
  }
};

/**
 * ADMIN: Update page
 */
export const updatePage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { title, content, seoTitle, metaDescription, status } = req.body || {};

    const page = await Page.findById(req.params.id);
    if (!page) {
      res.status(404).json({ message: 'Page not found' });
      return;
    }

    if (req.body?.slug !== undefined && req.body.slug !== page.slug) {
      const slug = normalizeSlug(req.body.slug);
      if (!slug) {
        res.status(400).json({ message: INVALID_SLUG_MESSAGE });
        return;
      }
      if (slug !== page.slug) {
        if (reservedHandles.includes(slug)) {
          res.status(400).json({ message: 'This URL handle is reserved and cannot be used.' });
          return;
        }
        if (await slugTakenByOtherPage(slug, page._id)) {
          res.status(400).json({ message: 'This URL handle is already in use.' });
          return;
        }

        // Save old slug to history for redirects; drop the new slug from history if reverting
        if (!page.slugHistory.includes(page.slug)) {
          page.slugHistory.push(page.slug);
        }
        page.slugHistory = page.slugHistory.filter((s) => s !== slug);
        page.slug = slug;
      }
    }

    if (typeof title === 'string' && title.trim()) page.title = title.trim();
    if (seoTitle !== undefined) page.seoTitle = optString(seoTitle, 300);
    if (metaDescription !== undefined) page.metaDescription = optString(metaDescription, 500);

    if (status !== undefined) {
      page.status = status === 'published' ? 'published' : 'draft';
      if (page.status === 'published' && !page.publishedAt) {
        page.publishedAt = new Date();
      }
    }

    if (content) {
      if (content.html !== undefined) {
        page.content.html = sanitizeRichHtml(content.html);
      }
      if (content.json !== undefined) {
        page.content.json = content.json;
      }
    }

    page.updatedBy = (req as any).user?._id;
    await page.save();

    // Public page caches (list + by slug) must not serve the old version
    await cacheDel('public:page*');
    // Trigger storefront rebuild automatically in the background
    triggerStorefrontRebuild();

    res.json(page);
  } catch (error) {
    next(error);
  }
};

/**
 * ADMIN: "Delete" archives the page (status 'archived') instead of removing it: it disappears
 * from the website and sitemap but its content is kept. Restore it with Save draft / Publish.
 */
export const deletePage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page = await Page.findByIdAndUpdate(req.params.id, { $set: { status: 'archived' } }, { new: true });
    if (!page) {
      res.status(404).json({ message: 'Page not found' });
      return;
    }

    // Public page caches (list + by slug) must not serve the old version
    await cacheDel('public:page*');
    // Trigger storefront rebuild automatically in the background
    triggerStorefrontRebuild();

    res.json({ message: 'Page archived' });
  } catch (error) {
    next(error);
  }
};

/**
 * PUBLIC: Get published page by slug.
 * - exact slug → 200 with public fields only
 * - old slug (in another page's slugHistory) → 200 { redirect: true, targetSlug }
 * - otherwise 404. Never exposes internal error messages.
 */
export const getPageBySlug = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const raw = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';
    if (!raw || raw.length > SLUG_MAX) {
      res.status(404).json({ message: 'Page not found' });
      return;
    }
    // Cached per slug (found pages and redirects only; misses are not cached)
    const CACHE_KEY = `public:page:${raw.toLowerCase()}`;
    const cached = await cacheGet(CACHE_KEY);
    if (cached) {
      res.json(cached);
      return;
    }

    // Accept legacy (pre-normalisation) slugs as stored, plus the lowercase form
    const candidates = Array.from(new Set([raw, raw.toLowerCase()]));

    let page = await Page.findOne({ slug: { $in: candidates }, status: 'published' });
    if (page) {
      const body = toPublicPage(page);
      await cacheSet(CACHE_KEY, body, TTL.PUBLIC_CONTENT);
      res.json(body);
      return;
    }

    page = await Page.findOne({ slugHistory: { $in: candidates }, status: 'published' });
    if (page) {
      const body = { redirect: true, targetSlug: page.slug };
      await cacheSet(CACHE_KEY, body, TTL.PUBLIC_CONTENT);
      res.status(200).json(body);
      return;
    }

    res.status(404).json({ message: 'Page not found' });
  } catch (error) {
    if (isDbUnavailableError(error)) return next(error); // → 503
    console.error('[Pages] getPageBySlug failed:', error);
    res.status(500).json({ message: 'Something went wrong' });
  }
};

/**
 * PUBLIC: Get list of active public pages (for sitemap/prerendering)
 */
export const getPublicPagesList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const CACHE_KEY = 'public:pages:list';
    const cached = await cacheGet(CACHE_KEY);
    if (cached) {
      res.json(cached);
      return;
    }
    const pages = await Page.find({ status: 'published' }, 'slug title updatedAt').sort({ updatedAt: -1 }).lean();
    await cacheSet(CACHE_KEY, pages, TTL.PUBLIC_CONTENT);
    res.json(pages);
  } catch (error) {
    if (isDbUnavailableError(error)) return next(error); // → 503
    console.error('[Pages] getPublicPagesList failed:', error);
    res.status(500).json({ message: 'Something went wrong' });
  }
};
