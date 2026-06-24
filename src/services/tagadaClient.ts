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

import axios, { AxiosInstance } from 'axios';
import config from '../config';
import PaymentSettings from '../models/PaymentSettings';

const BASE_URLS = {
  sandbox: 'https://app.tagadapay.dev/api/public/v1',
  prod: 'https://app.tagadapay.com/api/public/v1',
} as const;

/**
 * Build a fresh Axios instance using current config values.
 * Can be called with override credentials (e.g. from DB-backed settings).
 */
export function buildTagadaClient(opts?: {
  env?: 'sandbox' | 'prod';
  apiKeySandbox?: string;
  apiKeyProd?: string;
}): AxiosInstance {
  const env = opts?.env ?? config.tagadaEnv;
  const apiKey =
    env === 'prod'
      ? (opts?.apiKeyProd ?? config.tagadaApiKeyProd)
      : (opts?.apiKeySandbox ?? config.tagadaApiKeySandbox);

  return axios.create({
    baseURL: BASE_URLS[env],
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000, // 10 seconds
  });
}

// Singleton instance — used throughout the app
export let tagadaClient: AxiosInstance = buildTagadaClient();

/**
 * Rebuild the singleton (e.g. after admin updates credentials from the UI).
 */
export function rebuildTagadaClient(opts?: {
  env?: 'sandbox' | 'prod';
  apiKeySandbox?: string;
  apiKeyProd?: string;
}): void {
  tagadaClient = buildTagadaClient(opts);
}

/**
 * Loads settings from the database and initializes the client on startup.
 */
export async function initializeTagadaClientFromDB(): Promise<void> {
  try {
    const settings = await PaymentSettings.findOne();
    if (settings) {
      rebuildTagadaClient({
        env: settings.tagadaEnv as 'sandbox' | 'prod',
        apiKeySandbox: settings.tagadaApiKeySandbox,
        apiKeyProd: settings.tagadaApiKeyProd,
      });
      console.log('[TagadaPay] Initialized client from DB settings');
    }
  } catch (err) {
    console.error('[TagadaPay] Failed to initialize client from DB', err);
  }
}
