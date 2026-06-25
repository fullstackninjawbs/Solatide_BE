/**
 * tagadaClient.ts
 * ---------------
 * Axios instance pre-configured for the TagadaPay REST API.
 *
 * Base URLs:
 *   Sandbox : https://app.tagadapay.dev/api/public/v1
 *   Prod    : https://app.tagadapay.com/api/public/v1
 *
 * The active environment and API key are read from config at module load.
 * Call `rebuildTagadaClient()` after updating credentials from the DB so the
 * singleton picks up the new values without restarting the server.
 */

import config from '../config';
import PaymentSettings from '../models/PaymentSettings';

let TagadaSDK: any = null;

// Singleton instance
export let tagadaClient: any = null;

/**
 * Build a fresh Tagada instance using current config values.
 */
export async function buildTagadaClient(opts?: {
  env?: 'sandbox' | 'prod';
  apiKeySandbox?: string;
  apiKeyProd?: string;
}) {
  if (!TagadaSDK) {
    // Bypass TS compiler transpiling import() to require() in CommonJS
    const dynamicImport = new Function('modulePath', 'return import(modulePath)');
    const imported = await dynamicImport('@tagadapay/node-sdk');
    TagadaSDK = imported.default || imported.Tagada || imported;
  }

  const env = opts?.env ?? config.tagadaEnv;
  const apiKey =
    env === 'prod'
      ? (opts?.apiKeyProd || config.tagadaApiKeyProd)
      : (opts?.apiKeySandbox || config.tagadaApiKeySandbox);

  return new TagadaSDK(apiKey);
}

/**
 * Rebuild the singleton (e.g. after admin updates credentials from the UI).
 */
export async function rebuildTagadaClient(opts?: {
  env?: 'sandbox' | 'prod';
  apiKeySandbox?: string;
  apiKeyProd?: string;
}): Promise<void> {
  tagadaClient = await buildTagadaClient(opts);
}

/**
 * Loads settings from the database and initializes the client on startup.
 */
export async function initializeTagadaClientFromDB(): Promise<void> {
  try {
    const settings = await PaymentSettings.findOne();
    if (settings) {
      await rebuildTagadaClient({
        env: settings.tagadaEnv as 'sandbox' | 'prod',
        apiKeySandbox: settings.tagadaApiKeySandbox,
        apiKeyProd: settings.tagadaApiKeyProd,
      });
      console.log('[TagadaPay] Initialized client from DB settings');
    } else {
      await rebuildTagadaClient();
    }
  } catch (err) {
    console.error('[TagadaPay] Failed to initialize client from DB', err);
    await rebuildTagadaClient();
  }
}

export async function getTagadaClient() {
  if (!tagadaClient) {
    await rebuildTagadaClient();
  }
  return tagadaClient;
}
