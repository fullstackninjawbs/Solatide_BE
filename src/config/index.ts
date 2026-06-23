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
  corsOrigin: string;
  // TagadaPay
  tagadaEnv: 'sandbox' | 'prod';
  tagadaApiKeySandbox: string;
  tagadaApiKeyProd: string;
  tagadaWebhookSecret: string;
  tagadaDefaultCurrency: string;
  tagadaStoreId: string;
  tagadaAccountId: string;
}

const requiredEnv = ['JWT_SECRET', 'MONGO_URI'];

// Fail fast if crucial env variables are missing
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    throw new Error(`[Config Error] Missing required environment variable: ${envVar}`);
  }
}

export const config: Config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  mongoUri: process.env.MONGO_URI!,
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  // TagadaPay
  tagadaEnv: (process.env.TAGADA_ENV as 'sandbox' | 'prod') || 'sandbox',
  tagadaApiKeySandbox: process.env.TAGADA_API_KEY_SANDBOX || '',
  tagadaApiKeyProd: process.env.TAGADA_API_KEY_PROD || '',
  tagadaWebhookSecret: process.env.TAGADA_WEBHOOK_SECRET || '',
  tagadaDefaultCurrency: process.env.TAGADA_DEFAULT_CURRENCY || 'AUD',
  tagadaStoreId: process.env.TAGADA_STORE_ID || '',
  tagadaAccountId: process.env.TAGADA_ACCOUNT_ID || '',
};

export default config;
