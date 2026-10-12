import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

interface Config {
  env: string;
  port: number;
  mongoUri: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigin: string | string[];
  trustProxy: boolean | number | string;
  // TagadaPay
  tagadaEnv: 'sandbox' | 'production';
  tagadaApiKeySandbox: string;
  tagadaApiKeyProd: string;
  tagadaWebhookSecret: string;
  tagadaDefaultCurrency: string;
  tagadaStoreId: string;
  tagadaAccountId: string;
  tagadaOrgId: string;
  tagadaCheckoutUrl: string;
  // Cloudinary
  cloudinary: {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
  };
}

const requiredEnv = ['JWT_SECRET', 'MONGO_URI'];

// Fail fast if crucial env variables are missing
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    throw new Error(`[Config Error] Missing required environment variable: ${envVar}`);
  }
}

const PLACEHOLDER_JWT_SECRETS = ['your_super_secret_jwt_key_here', 'changeme', 'secret'];

if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32 || PLACEHOLDER_JWT_SECRETS.includes(secret)) {
    throw new Error(
      '[Config Error] JWT_SECRET is too weak for production (min 32 chars, must not be the .env.example placeholder).'
    );
  }
}

// Running under PM2 (pm_id is set) but not in production mode is almost always a
// deployment mistake (pm2 start without --env production). Warn loudly.
if (process.env.pm_id !== undefined && process.env.NODE_ENV !== 'production') {
  console.warn(
    `[Config Warning] Running under PM2 with NODE_ENV=${process.env.NODE_ENV || '(unset)'} — ` +
      'development error output is enabled. Set NODE_ENV=production in ecosystem.config.js.'
  );
}

/** express 'trust proxy' setting: number of hops, or true/false/'loopback' etc. */
const parseTrustProxy = (raw: string | undefined): boolean | number | string => {
  if (raw === undefined || raw === '') return 1;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
};

export const config: Config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  mongoUri: process.env.MONGO_URI!,
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
    : 'http://localhost:5173',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // TagadaPay
  tagadaEnv: (process.env.TAGADA_ENV as 'sandbox' | 'production') || 'sandbox',
  tagadaApiKeySandbox: process.env.TAGADA_API_KEY_SANDBOX || '',
  tagadaApiKeyProd: process.env.TAGADA_API_KEY_PROD || '',
  tagadaWebhookSecret: process.env.TAGADA_WEBHOOK_SECRET || '',
  tagadaDefaultCurrency: process.env.TAGADA_DEFAULT_CURRENCY || 'AUD',
  tagadaStoreId: process.env.TAGADA_STORE_ID || '',
  tagadaAccountId: process.env.TAGADA_ACCOUNT_ID || '',
  tagadaOrgId: process.env.TAGADA_ORG_ID || 'gracie-collins-1779009767064524065',
  tagadaCheckoutUrl: process.env.TAGADA_CHECKOUT_URL || '',
  // Cloudinary
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
};

export default config;
