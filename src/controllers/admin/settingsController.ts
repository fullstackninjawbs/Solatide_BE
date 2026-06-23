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

export const updateTagadaSettings = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const {
      tagadaEnv,
      tagadaApiKeySandbox,
      tagadaApiKeyProd,
      tagadaWebhookSecret,
      tagadaEnabled,
    } = req.body;

    if (tagadaEnv && !['sandbox', 'prod'].includes(tagadaEnv)) {
      return next(new AppError("tagadaEnv must be 'sandbox' or 'prod'", 400));
    }

    let settings = await PaymentSettings.findOne();
    if (!settings) {
      settings = await PaymentSettings.create({});
    }

    // Only update fields that were actually sent
    if (tagadaEnv !== undefined) settings.tagadaEnv = tagadaEnv;
    if (tagadaApiKeySandbox !== undefined) settings.tagadaApiKeySandbox = tagadaApiKeySandbox;
    if (tagadaApiKeyProd !== undefined) settings.tagadaApiKeyProd = tagadaApiKeyProd;
    if (tagadaWebhookSecret !== undefined) settings.tagadaWebhookSecret = tagadaWebhookSecret;
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

// Legacy placeholder (preserved for other admin sections still using it)
export const getPlaceholder = async (req: Request, res: Response) => {
  res.json({ message: 'Settings controller — use /tagada sub-routes' });
};
