import { Request, Response, NextFunction } from 'express';
import Redirect from '../../models/redirect.model';
import { AuditLog } from '../../models/auditLog.model';
import AppError from '../../utils/appError';
import catchAsync from '../../utils/catchAsync';
import { escapeRegex } from '../../utils/collectionUtils';
import { isProtectedPath, isValidInternalTarget, normalizePath } from '../../utils/redirectPaths';
import { clearRedirectCache } from '../../services/redirects';
import { isLiveItem, targetStatus } from '../../services/redirectResolver';

const ID_RE = /^[0-9a-fA-F]{24}$/;

/** Audit trail for every admin change (never blocks the request). */
function audit(req: Request, action: string, id: unknown, before: unknown, after: unknown): void {
  const user: any = (req as any).user;
  if (!user?._id) return;
  AuditLog.create({
    userId: user._id, action, entityType: 'Redirect', entityId: id,
    beforeSnapshot: before ?? undefined, afterSnapshot: after ?? undefined,
    ipAddress: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  }).catch((err: any) => console.error('[Redirects] audit log failed:', err?.message));
}

/**
 * Validate a target typed by an admin: an on-site path (query allowed). The path part is
 * normalised like any redirect path; the query is kept as typed.
 */
function cleanTarget(raw: unknown): { full: string; path: string } | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // Website addresses are refused outright (not "cleaned" into an on-site path)
  if (/^\/\/|:\/\/|\\/.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  const q = s.indexOf('?');
  const path = normalizePath(q >= 0 ? s.slice(0, q) : s);
  if (!path) return null;
  const full = q >= 0 ? path + s.slice(q) : path;
  return isValidInternalTarget(full) ? { full, path } : null;
}

/**
 * The final destination for a new/edited redirect fromPath → target: follows an active redirect
 * at the target (one hop, so chains never form) and refuses loops back to fromPath.
 */
async function finalTarget(fromPath: string, target: { full: string; path: string }, selfId?: unknown): Promise<{ full: string; path: string; followed: boolean } | { error: string }> {
  if (target.path === fromPath) return { error: 'The new URL must be different from the old URL.' };
  const filter: any = { active: true, fromPath: target.path };
  if (selfId) filter._id = { $ne: selfId };
  const next: any = await Redirect.findOne(filter).select('toPath').lean();
  if (!next) return { ...target, followed: false };
  const nextPath = String(next.toPath).split('?')[0];
  if (nextPath === fromPath) return { error: `That would create a loop: ${target.path} already redirects back to ${fromPath}.` };
  return { full: next.toPath, path: nextPath, followed: true };
}

// GET /api/admin/redirects?page&limit&q&source&status&to
export const listRedirects = catchAsync(async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 25));
  const filter: any = {};
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  if (q) {
    const rx = { $regex: escapeRegex(q.toLowerCase()), $options: 'i' };
    filter.$or = [{ fromPath: rx }, { toPath: rx }, { note: rx }];
  }
  if (['auto', 'manual', 'import'].includes(String(req.query.source))) filter.source = req.query.source;
  if (req.query.status === 'active') filter.active = true;
  if (req.query.status === 'disabled') filter.active = false;
  if (typeof req.query.to === 'string' && req.query.to) {
    const to = normalizePath(req.query.to);
    if (to) filter.toPath = { $in: [to, new RegExp(`^${escapeRegex(to)}\\?`)] };
  }

  const [rows, total] = await Promise.all([
    Redirect.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Redirect.countDocuments(filter),
  ]);
  const redirects = await Promise.all(rows.map(async (r: any) => ({ ...r, targetStatus: await targetStatus(String(r.toPath)) })));
  res.status(200).json({ success: true, data: { redirects }, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// POST /api/admin/redirects  { fromPath, toPath, statusCode?, note? }
export const createRedirect = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const fromPath = normalizePath(req.body?.fromPath);
  if (!fromPath) return next(new AppError('Old URL must be a path on this site, e.g. /products/old-name.', 400));
  if (isProtectedPath(fromPath)) return next(new AppError(`${fromPath} can't be redirected (home page, checkout, account, admin and system URLs are protected).`, 400));
  const target = cleanTarget(req.body?.toPath);
  if (!target) return next(new AppError('New URL must be a path on this site starting with "/", e.g. /products/new-name.', 400));
  if (await isLiveItem(fromPath)) return next(new AppError(`A live page exists at ${fromPath}. Real pages always win, so it can't be redirected — archive or rename it first.`, 400));

  const existing: any = await Redirect.findOne({ active: true, fromPath }).select('toPath').lean();
  if (existing) return next(new AppError(`${fromPath} already redirects to ${existing.toPath}. Edit that redirect instead.`, 400));
  const dest = await finalTarget(fromPath, target);
  if ('error' in dest) return next(new AppError(dest.error, 400));

  const statusCode = Number(req.body?.statusCode) === 302 ? 302 : 301;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : undefined;
  let created;
  try {
    created = await Redirect.create({ fromPath, toPath: dest.full, statusCode, source: 'manual', note, createdBy: (req as any).user?._id ?? null, updatedBy: (req as any).user?._id ?? null });
  } catch (err: any) {
    if (err?.code === 11000) return next(new AppError(`${fromPath} already has an active redirect.`, 400));
    throw err;
  }
  // Redirects that pointed at the old URL now go straight to the destination (one hop)
  await Redirect.updateMany({ active: true, toPath: fromPath, _id: { $ne: created._id } }, { $set: { toPath: dest.full } });
  await clearRedirectCache();
  audit(req, 'redirect.create', created._id, null, created.toObject());
  res.status(201).json({
    success: true,
    message: dest.followed ? `Created. ${target.path} itself redirects, so this goes straight to ${dest.full}.` : 'Redirect created.',
    data: { redirect: created },
  });
});

// PATCH /api/admin/redirects/:id  { toPath?, statusCode?, note?, active? }
export const updateRedirect = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!ID_RE.test(req.params.id)) return next(new AppError('Redirect not found.', 404));
  const doc = await Redirect.findById(req.params.id);
  if (!doc) return next(new AppError('Redirect not found.', 404));
  const before = doc.toObject();
  let message = 'Redirect updated.';

  if (req.body?.toPath !== undefined) {
    const target = cleanTarget(req.body.toPath);
    if (!target) return next(new AppError('New URL must be a path on this site starting with "/", e.g. /products/new-name.', 400));
    const dest = await finalTarget(doc.fromPath, target, doc._id);
    if ('error' in dest) return next(new AppError(dest.error, 400));
    doc.toPath = dest.full;
    if (dest.followed) message = `Updated. ${target.path} itself redirects, so this goes straight to ${dest.full}.`;
  }
  if (req.body?.statusCode !== undefined) doc.statusCode = Number(req.body.statusCode) === 302 ? 302 : 301;
  if (req.body?.note !== undefined) doc.note = String(req.body.note ?? '').trim().slice(0, 500);
  if (req.body?.active !== undefined) {
    const wantActive = req.body.active === true || req.body.active === 'true';
    if (wantActive && !doc.active) {
      if (isProtectedPath(doc.fromPath)) return next(new AppError(`${doc.fromPath} can't be redirected.`, 400));
      if (await isLiveItem(doc.fromPath)) return next(new AppError(`A live page exists at ${doc.fromPath}, so this redirect can't be enabled (real pages always win).`, 400));
      const other: any = await Redirect.findOne({ active: true, fromPath: doc.fromPath, _id: { $ne: doc._id } }).select('toPath').lean();
      if (other) return next(new AppError(`${doc.fromPath} already redirects to ${other.toPath}. Disable that one first.`, 400));
    }
    doc.active = wantActive;
  }
  doc.updatedBy = (req as any).user?._id ?? null;
  try {
    await doc.save();
  } catch (err: any) {
    if (err?.code === 11000) return next(new AppError(`${doc.fromPath} already has an active redirect.`, 400));
    throw err;
  }
  await clearRedirectCache();
  audit(req, 'redirect.update', doc._id, before, doc.toObject());
  res.status(200).json({ success: true, message, data: { redirect: doc } });
});

