import type { Schema } from 'mongoose';
import type { RedirectEntityKind } from '../models/redirect.model';
import { recordSlugChange, releasePath } from '../services/redirects';

/** Does a query update object change `slug`? (plain field or $set; pipelines never set slugs) */
const touchesSlug = (u: any): boolean =>
  !!u && !Array.isArray(u) && (Object.prototype.hasOwnProperty.call(u, 'slug') || (!!u.$set && Object.prototype.hasOwnProperty.call(u.$set, 'slug')));

const log = (kind: string, err: unknown) =>
  console.error(`[Redirects] ${kind} hook failed (the save itself succeeded): ${(err as Error)?.message ?? err}`);

/**
 * Automatic 301s for products, collections and CMS pages — at the model level, so every write
 * path is covered (admin forms, admin API, imports, scripts):
 *  - URL changed (save() or findOneAndUpdate/updateOne) → recordSlugChange(old, new)
 *  - new item created at a URL → releasePath (a redirect from that URL is disabled)
 * Never blocks or fails the write: errors are logged only.
 */
export function registerSlugRedirectHooks(schema: Schema, kind: RedirectEntityKind): void {
  // ── document saves ──
  schema.post('init', function (doc: any) {
    doc.$locals.redirectLoadedSlug = doc.slug;
  });
  schema.pre('save', function (this: any, next: () => void) {
    this.$locals.redirectWasNew = this.isNew;
    this.$locals.redirectPrevSlug = this.isNew ? undefined : this.$locals.redirectLoadedSlug;
    next();
  });
  schema.post('save', async function (doc: any) {
    try {
      if (doc.$locals.redirectWasNew) await releasePath(kind, doc.slug);
      else if (doc.$locals.redirectPrevSlug && doc.$locals.redirectPrevSlug !== doc.slug) {
        await recordSlugChange(kind, doc._id, doc.$locals.redirectPrevSlug, doc.slug);
      }
      doc.$locals.redirectLoadedSlug = doc.slug;
    } catch (err) {
      log(kind, err);
    }
  });

  // ── query updates (e.g. updateProduct uses findByIdAndUpdate) ──
  for (const op of ['findOneAndUpdate', 'updateOne'] as const) {
    schema.pre(op, async function (this: any) {
      try {
        if (!touchesSlug(this.getUpdate())) return;
        this._redirectPrev = await this.model.findOne(this.getFilter()).select('_id slug').lean();
      } catch (err) {
        log(kind, err);
      }
    });
    schema.post(op, async function (this: any) {
      const prev = this._redirectPrev;
      if (!prev) return;
      try {
        const now: any = await this.model.findById(prev._id).select('slug').lean();
        if (now && now.slug && now.slug !== prev.slug) await recordSlugChange(kind, prev._id, prev.slug, now.slug);
      } catch (err) {
        log(kind, err);
      }
    });
  }
}
