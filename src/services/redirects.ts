import mongoose from 'mongoose';
import Redirect, { RedirectEntityKind } from '../models/redirect.model';
import { cacheDel } from '../utils/cache';
import { isProtectedPath, pathFor } from '../utils/redirectPaths';

/** Resolver answers are cached under redirects:*; every redirect change clears them. */
export async function clearRedirectCache(): Promise<void> {
  await cacheDel('redirects:*');
}

/**
 * An item's URL changed from oldSlug to newSlug: leave a 301 behind, automatically.
 *  1. the item now lives at the new URL → a redirect FROM it would hide the page (e.g. renamed
 *     back A → B → A): disable it ("the real page wins")
 *  2. chains collapse: every redirect pointing at the old URL (and every auto redirect of this
 *     item) now points straight at the new URL — always one hop
 *  3. create old → new (or update an existing active redirect from the old URL)
 *  4. never keep a redirect that points at itself
 * Protected paths (/, /admin, /api, /checkout, /collections/all, …) are never touched.
 */
export async function recordSlugChange(kind: RedirectEntityKind, id: unknown, oldSlug: unknown, newSlug: unknown): Promise<void> {
  if (!oldSlug || !newSlug) return;
  const from = pathFor(kind, String(oldSlug));
  const to = pathFor(kind, String(newSlug));
  if (from === to || isProtectedPath(from) || isProtectedPath(to)) return;
  const entityId = new mongoose.Types.ObjectId(String(id));

  await Redirect.updateMany({ active: true, fromPath: to }, { $set: { active: false, note: 'Disabled automatically: a page now lives at this URL' } });
  await Redirect.updateMany({ active: true, toPath: from }, { $set: { toPath: to } });
  await Redirect.updateMany({ active: true, 'entity.kind': kind, 'entity.id': entityId }, { $set: { toPath: to } });

  const existing = await Redirect.findOne({ active: true, fromPath: from });
  if (existing) {
    existing.toPath = to;
    existing.entity = { kind, id: entityId };
    await existing.save();
  } else {
    try {
      await Redirect.create({ fromPath: from, toPath: to, source: 'auto', entity: { kind, id: entityId } });
    } catch (err: any) {
      // Another request created it at the same moment (unique active fromPath): point it here
      if (err?.code !== 11000) throw err;
      await Redirect.updateOne({ active: true, fromPath: from }, { $set: { toPath: to, entity: { kind, id: entityId } } });
    }
  }

  await Redirect.updateMany(
    { active: true, $expr: { $eq: ['$fromPath', '$toPath'] } },
    { $set: { active: false, note: 'Disabled automatically: pointed at itself' } }
  );
  await clearRedirectCache();
  console.log(`[Redirects] ${kind} URL changed: ${from} → ${to} (301 created)`);
}

/** A new item now lives at this URL: any active redirect from it is disabled (the real page wins). */
export async function releasePath(kind: RedirectEntityKind, slug: unknown): Promise<void> {
  if (!slug) return;
  const path = pathFor(kind, String(slug));
  if (isProtectedPath(path)) return;
  const res = await Redirect.updateMany({ active: true, fromPath: path }, { $set: { active: false, note: 'Disabled automatically: a page now lives at this URL' } });
  if (res.modifiedCount > 0) {
    await clearRedirectCache();
    console.log(`[Redirects] ${path} is now a real ${kind}: its redirect was disabled`);
  }
}
