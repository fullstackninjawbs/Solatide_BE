/**
 * settingsController.ts
 * ─────────────────────
 * Admin settings handlers (store, checkout mode, bank transfer, ...).
 * Settings are persisted in MongoDB so admins can update them from the UI
 * without redeploying the server.
 */

import { Request, Response, NextFunction } from 'express';
import PaymentSettings from '../../models/PaymentSettings';
import StoreSettings from '../../models/StoreSettings';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';

// ─── GET /api/admin/settings/store ──────────────────────────────────────────────

export const getStoreSettings = catchAsync(async (_req: Request, res: Response) => {
  let settings = await StoreSettings.findOne();
  if (!settings) {
    settings = await StoreSettings.create({
      storeName: 'Solatide Biosciences',
      contactEmail: 'contact@solatidebiosciences.com.au'
    });
  }

  res.status(200).json({
    success: true,
    data: { settings },
  });
});

// ─── PUT /api/admin/settings/store ──────────────────────────────────────────────

export const updateStoreSettings = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  let settings = await StoreSettings.findOne();
  if (!settings) {
    settings = new StoreSettings();
  }

  const { storeName, contactEmail, contactPhone, shippingOrigin, baseCurrency, freeShippingThreshold } = req.body;

  if (storeName !== undefined) settings.storeName = storeName;
  if (contactEmail !== undefined) settings.contactEmail = contactEmail;
  if (contactPhone !== undefined) settings.contactPhone = contactPhone;
  if (shippingOrigin !== undefined) settings.shippingOrigin = shippingOrigin;
  if (baseCurrency !== undefined) settings.baseCurrency = baseCurrency;
  if (freeShippingThreshold !== undefined) settings.freeShippingThreshold = freeShippingThreshold;

  await settings.save();

  res.status(200).json({
    success: true,
    message: 'Store settings updated successfully',
    data: { settings }
  });
});

// ─── Bank transfer / PayID checkout ─────────────────────────────────────────────
// GET /api/admin/settings/bank-transfer · PUT (payment settings permission)

const BANK_TEXT_FIELDS = ['accountName', 'bankName', 'bsb', 'accountNumber', 'payId', 'swiftBic', 'iban', 'beneficiaryAddress'] as const;
const BANK_TEXT_MAX: Partial<Record<(typeof BANK_TEXT_FIELDS)[number], number>> = { beneficiaryAddress: 250 };
const BANK_NUMBER_FIELDS = ['shippingFeeAU', 'shippingFeeInternational', 'freeShippingThresholdAU', 'unpaidCancelDays', 'unpaidCancelDaysInternational'] as const;
const BANK_DAY_FIELDS: readonly string[] = ['unpaidCancelDays', 'unpaidCancelDaysInternational'];
const BANK_BOOL_FIELDS = ['enabled', 'internationalEnabled', 'notifyAdminOnOrder'] as const;

/** Bank settings + whether the bank transfer checkout is the live one (checkout mode). */
async function bankTransferResponse() {
  const { publicCheckoutConfig } = await import('../../services/checkout/bankTransfer');
  const { getCheckoutModeState, bankTransferReady } = await import('../../services/checkout/checkoutMode');
  const state = await getCheckoutModeState();
  const doc: any = await PaymentSettings.findOne().select('bankTransfer').lean();
  return {
    settings: state.bank,
    saved: doc?.bankTransfer || {},
    ready: bankTransferReady(state.bank),
    checkout: { ...publicCheckoutConfig(state.bank), mode: state.mode },
  };
}

export const getBankTransferSettings = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: await bankTransferResponse() });
});

export const updateBankTransferSettings = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const body = req.body || {};
  const set: Record<string, unknown> = {};
  for (const k of BANK_TEXT_FIELDS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'string' || body[k].length > (BANK_TEXT_MAX[k] ?? 120)) return next(new AppError(`Invalid ${k}`, 400));
    set[`bankTransfer.${k}`] = body[k].trim();
  }
  for (const k of BANK_NUMBER_FIELDS) {
    if (body[k] === undefined || body[k] === '') continue;
    const n = Number(body[k]);
    const days = BANK_DAY_FIELDS.includes(k);
    const max = days ? 60 : 100000;
    if (!Number.isFinite(n) || n < (days ? 1 : 0) || n > max) return next(new AppError(`Invalid ${k}`, 400));
    set[`bankTransfer.${k}`] = days ? Math.floor(n) : Math.round(n * 100) / 100;
  }
  for (const k of BANK_BOOL_FIELDS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') return next(new AppError(`Invalid ${k}`, 400));
    set[`bankTransfer.${k}`] = body[k];
  }
  if (!Object.keys(set).length) return next(new AppError('No valid fields to update', 400));
  await PaymentSettings.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const data = await bankTransferResponse();
  const modeDoc: any = await PaymentSettings.findOne().select('checkoutMode').lean();
  if (modeDoc?.checkoutMode === 'bank_transfer' && !data.ready) {
    return res.status(200).json({ success: true, warning: 'Saved, but the bank transfer checkout cannot take orders until the PayID or bank account details are filled in. Customers get the previous checkout meanwhile.', data });
  }
  res.status(200).json({ success: true, message: 'Bank transfer settings saved', data });
});

// ─── Checkout mode ────────────────────────────────────────────────────────────
// GET /api/admin/settings/checkout-mode · PUT (payment settings permission: super_admin)

async function checkoutModeResponse() {
  const { getCheckoutModeState, checkoutModeOptions } = await import('../../services/checkout/checkoutMode');
  const state = await getCheckoutModeState();
  return {
    mode: state.mode,
    saved: state.saved,
    options: checkoutModeOptions(state.bank),
    changedAt: state.changedAt || null,
    changedBy: state.changedBy || null,
  };
}

export const getCheckoutMode = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: await checkoutModeResponse() });
});

export const updateCheckoutMode = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { isCheckoutMode, checkoutModeOptions, getCheckoutModeState } = await import('../../services/checkout/checkoutMode');
  const mode = req.body?.mode;
  if (!isCheckoutMode(mode)) return next(new AppError('Please choose a checkout mode.', 400));
  const before = await getCheckoutModeState();
  const option = checkoutModeOptions(before.bank).find((o) => o.id === mode);
  if (!option || option.status !== 'ready') {
    return next(new AppError(option?.hint || 'This checkout mode is not available yet.', 400));
  }
  const user: any = (req as any).user;
  const doc: any = await PaymentSettings.findOneAndUpdate(
    {},
    { $set: { checkoutMode: mode, checkoutModeChangedAt: new Date(), checkoutModeChangedBy: String(user?.email || 'admin').slice(0, 200) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).select('_id').lean();
  if (user?._id && doc?._id) {
    const { AuditLog } = await import('../../models/auditLog.model');
    AuditLog.create({
      userId: user._id, action: 'checkout_mode_changed', entityType: 'PaymentSettings', entityId: doc._id,
      beforeSnapshot: { mode: before.mode, saved: before.saved }, afterSnapshot: { mode },
      ipAddress: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    }).catch((err: any) => console.error('[Settings] checkout mode audit log failed:', err?.message));
  }
  console.log(`[Settings] Checkout mode: ${before.mode} → ${mode} (by ${user?.email || 'admin'})`);
  res.status(200).json({ success: true, message: `Checkout mode set to ${option.label}. Customers use it from their next Check out.`, data: await checkoutModeResponse() });
});

// ── Storefront updates (rebuild of the prebuilt website) ────────────────────────
/** A build marked "building" for longer than this is shown as interrupted (e.g. server restart). */
const REBUILD_STALE_MS = 45 * 60 * 1000;

/** GET /api/admin/settings/storefront-rebuild — last request / build / result. */
export const getStorefrontRebuildStatus = catchAsync(async (_req: Request, res: Response) => {
  const { getRebuildStatus } = await import('../../services/storefront/rebuildStatus');
  const { storefrontRebuildEnabled } = await import('../../utils/rebuildStorefront');
  const s: any = (await getRebuildStatus()) || {};
  const building = !!s.building && !!s.lastStartedAt && Date.now() - new Date(s.lastStartedAt).getTime() < REBUILD_STALE_MS;
  // Waiting = asked for after the last build started (debounced ~10 s, or queued behind a running build)
  const waiting = !!s.lastRequestedAt && (!s.lastStartedAt || new Date(s.lastRequestedAt) > new Date(s.lastStartedAt));
  res.status(200).json({
    success: true,
    data: {
      enabled: storefrontRebuildEnabled(),
      building,
      waiting,
      lastRequestedAt: s.lastRequestedAt || null,
      lastRequestedBy: s.lastRequestedBy || null,
      lastStartedAt: s.lastStartedAt || null,
      lastFinishedAt: s.lastFinishedAt || null,
      lastResult: s.lastResult || null,
      lastSuccessAt: s.lastSuccessAt || null,
      lastFailureAt: s.lastFailureAt || null,
      consecutiveFailures: s.consecutiveFailures || 0,
    },
  });
});

/** POST /api/admin/settings/storefront-rebuild — "Rebuild now" (debounced like every other request). */
export const requestStorefrontRebuild = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { triggerStorefrontRebuild, storefrontRebuildEnabled } = await import('../../utils/rebuildStorefront');
  if (!storefrontRebuildEnabled()) {
    return next(new AppError('Automatic website updates are switched off on this server (STOREFRONT_AUTO_REBUILD=false).', 409));
  }
  const { adminLabelOf } = await import('../../services/orders/confirmationEmail');
  const { recordRebuildRequested } = await import('../../services/storefront/rebuildStatus');
  const by = `manual: ${adminLabelOf((req as any).user)}`;
  await recordRebuildRequested(by); // so the status shows "queued" as soon as this returns
  triggerStorefrontRebuild(by);
  res.status(202).json({ success: true, message: 'Website update requested. It starts in about 10 seconds and usually takes a few minutes.' });
});
