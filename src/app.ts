import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import compression from 'compression';
import config from './config';
import apiRoutes from './routes';
import productRoutes from './routes/product.routes';
import adminRoutes from './routes/admin';
import paymentRoutes from './routes/payment.routes';
import redirectRoutes from './routes/redirect.routes';
import errorHandler from './middleware/errorHandler';
import AppError from './utils/appError';
import analyticsRoutes from './routes/analytics.routes';
import { generalLimiter, publicLimiter, analyticsLimiter } from './middleware/rateLimit';
import healthRoutes from './routes/health.routes';
import pageRoutes from './routes/public.page.routes';

/**
 * Configured Express application (middleware + routes + error handler).
 * No DB connection and no listen() here — see server.ts. Tests import this module.
 */
const app = express();

// Trust reverse proxy (NGINX) hops for X-Forwarded-For (rate limiting / req.ip).
// Configure with TRUST_PROXY (default 1 = one proxy hop).
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

// Global Middleware Stack
app.use(helmet()); // Security headers
app.use(compression()); // Compress all responses for speed

// CORS configuration matching configured origins
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);

// ── Body parsers ─────────────────────────────────────────────────────────────
// Public endpoints get a small limit; only authenticated admin/product-write
// requests (which may carry large rich-HTML payloads) get 10 MB.
const smallJson = express.json({ limit: '100kb' });
const largeJson = express.json({ limit: '10mb' });

const needsLargeBody = (req: Request): boolean => {
  const hasBearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
  if (!hasBearer) return false;
  if (req.path.startsWith('/api/admin/')) return true;
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
  return isWrite && (req.path.startsWith('/api/products') || req.path.startsWith('/api/v1/products'));
};

app.use((req: Request, res: Response, next: NextFunction) => {
  // Tagada webhook uses express.raw() in its own route for signature verification
  if (req.path === '/api/payments/tagada/webhook') return next();
  return (needsLargeBody(req) ? largeJson : smallJson)(req, res, next);
});

// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// Logging middleware
if (config.env === 'development') {
  app.use(morgan('dev'));
} else if (config.env !== 'test') {
  app.use(morgan('combined'));
}

// Apply global rate limiter (after body parsing, before routes)
app.use(generalLimiter);

// Enforce 301 Permanent Redirect for URLs with trailing slashes (SEO normalization for page routes only)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/api/') && req.path.length > 1 && req.path.endsWith('/')) {
    const query = req.url.slice(req.path.length);
    const cleanPath = req.path.slice(0, -1);
    res.redirect(301, cleanPath + query);
    return;
  }
  next();
});

// Base legacy health/status endpoint for backward compatibility
app.get('/api/status', (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Solatide Biosciences API is running successfully',
    timestamp: new Date().toISOString(),
  });
});

// Health check — no auth
app.use('/api/health', healthRoutes);

// Register Direct and Versioned API Routes
app.use('/api/products', publicLimiter, productRoutes);
app.use('/api/pages', pageRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/v1', apiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/analytics', analyticsLimiter, analyticsRoutes); // Public storefront event tracking
app.use('/api/redirects', publicLimiter, redirectRoutes); // Old URL → new URL (nginx fallback + app)

// Catch-all: 404 Route handler for unregistered paths
app.all('*', (req: Request, res: Response, next: NextFunction) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Centralized Global Error Handler Middleware
app.use(errorHandler);

export default app;
