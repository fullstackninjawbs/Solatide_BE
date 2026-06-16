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
};

export default config;
