/**
 * settingsController.ts
 * ─────────────────────
 * Admin settings handlers — currently focused on TagadaPay configuration.
 * Settings are persisted in MongoDB (PaymentSettings collection) so admins
 * can update credentials from the UI without redeploying the server.
 *
 * After saving new Tagada credentials, rebuildTagadaClient() is called to
 * hot-swap the singleton without a server restart.
 */

import { Request, Response, NextFunction } from 'express';
import PaymentSettings from '../../models/PaymentSettings';
import StoreSettings from '../../models/StoreSettings';
import { rebuildTagadaClient } from '../../services/tagadaClient';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';

// ─── GET /api/admin/settings/tagada ──────────────────────────────────────────

export const getTagadaSettings = catchAsync(
  async (_req: Request, res: Response) => {
    // Return the first (singleton) settings document; create defaults if none
    let settings = await PaymentSettings.findOne();
    if (!settings) {
      settings = await PaymentSettings.create({});
    }

    // Mask sensitive keys — return only the last 4 characters
    const mask = (key: string) =>
      key && key.length > 4 ? `${'*'.repeat(key.length - 4)}${key.slice(-4)}` : '****';

    res.status(200).json({
      success: true,
      data: {
        tagadaEnv: settings.tagadaEnv,
        tagadaApiKeySandbox: mask(settings.tagadaApiKeySandbox),
        tagadaApiKeyProd: mask(settings.tagadaApiKeyProd),
        tagadaWebhookSecret: mask(settings.tagadaWebhookSecret),
        tagadaEnabled: settings.tagadaEnabled,
      },
    });
  }
);

// ─── PUT /api/admin/settings/tagada ──────────────────────────────────────────

/**
 * A secret field is only updated when a NEW value is typed. The GET above returns masked values
 * ("****abcd") and the form sends the whole form back, so a masked or empty value means
 * "unchanged" — saving the page must never replace the real key with its mask.
 */
const isNewSecret = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && !v.includes('****');

export const updateTagadaSettings = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      tagadaEnv,
      tagadaApiKeySandbox,
      tagadaApiKeyProd,
      tagadaWebhookSecret,
      tagadaEnabled,
    } = req.body;

    if (tagadaEnv && !['sandbox', 'production'].includes(tagadaEnv)) {
      return next(new AppError("tagadaEnv must be 'sandbox' or 'production'", 400));
    }

    let settings = await PaymentSettings.findOne();
    if (!settings) {
      settings = await PaymentSettings.create({});
    }

    // Only update fields that were actually sent
    if (tagadaEnv !== undefined) settings.tagadaEnv = tagadaEnv;
    if (isNewSecret(tagadaApiKeySandbox)) settings.tagadaApiKeySandbox = tagadaApiKeySandbox.trim();
    if (isNewSecret(tagadaApiKeyProd)) settings.tagadaApiKeyProd = tagadaApiKeyProd.trim();
    if (isNewSecret(tagadaWebhookSecret)) settings.tagadaWebhookSecret = tagadaWebhookSecret.trim();
    if (tagadaEnabled !== undefined) settings.tagadaEnabled = tagadaEnabled;

    await settings.save();

    // Hot-reload the Tagada client singleton with the new credentials
    rebuildTagadaClient({
      env: settings.tagadaEnv,
      apiKeySandbox: settings.tagadaApiKeySandbox,
      apiKeyProd: settings.tagadaApiKeyProd,
    });

    console.log('[Settings] TagadaPay settings updated and client rebuilt.');

    res.status(200).json({
      success: true,
      message: 'TagadaPay settings saved successfully',
    });
  }
);

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

const BANK_TEXT_FIELDS = ['accountName', 'bankName', 'bsb', 'accountNumber', 'payId', 'swiftBic'] as const;
const BANK_NUMBER_FIELDS = ['shippingFeeAU', 'shippingFeeInternational', 'freeShippingThresholdAU', 'unpaidCancelDays'] as const;
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
    if (typeof body[k] !== 'string' || body[k].length > 120) return next(new AppError(`Invalid ${k}`, 400));
    set[`bankTransfer.${k}`] = body[k].trim();
  }
  for (const k of BANK_NUMBER_FIELDS) {
    if (body[k] === undefined || body[k] === '') continue;
    const n = Number(body[k]);
    const max = k === 'unpaidCancelDays' ? 60 : 100000;
    if (!Number.isFinite(n) || n < (k === 'unpaidCancelDays' ? 1 : 0) || n > max) return next(new AppError(`Invalid ${k}`, 400));
    set[`bankTransfer.${k}`] = k === 'unpaidCancelDays' ? Math.floor(n) : Math.round(n * 100) / 100;
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
