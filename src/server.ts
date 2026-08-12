import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import compression from 'compression';
import mongoose from 'mongoose';
import config from './config';
import connectDB from './config/db';
import apiRoutes from './routes';
import productRoutes from './routes/product.routes';
import adminRoutes from './routes/admin';
import paymentRoutes from './routes/payment.routes';
import errorHandler from './middleware/errorHandler';
import AppError from './utils/appError';
import analyticsRoutes from './routes/analytics.routes';
import { generalLimiter, authLimiter, publicLimiter } from './middleware/rateLimit';
import healthRoutes from './routes/health.routes';

// Handle uncaught exceptions before any other code executes
process.on('uncaughtException', (err: Error) => {
  console.error('[UNCAUGHT EXCEPTION] Shutting down server...');
  console.error(err.name, err.message, err.stack);
  process.exit(1);
});

// Initialize Express app
const app = express();

import { initializeTagadaClientFromDB } from './services/tagadaClient';

// Connect to MongoDB Database and initialize DB-backed singletons
connectDB().then(() => {
  initializeTagadaClientFromDB();
});

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

// Body parser (capped to prevent payload injection)
// Skip for webhook path (already handled by express.raw above)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/api/payments/tagada/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});

// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// Logging middleware
if (config.env === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Apply global rate limiter (after body parsing, before routes)
app.use(generalLimiter);

// Base legacy health/status endpoint for backward compatibility
app.get('/api/status', (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Solatide Biosciences API is running successfully',
    timestamp: new Date().toISOString(),
    env: config.env,
  });
});

// Health check — no auth, no rate limit, highest priority
app.use('/health', healthRoutes);

// Register Direct and Versioned API Routes
app.use('/api/products', publicLimiter, productRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/v1', apiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/analytics', analyticsRoutes); // Public storefront event tracking

// Catch-all: 404 Route handler for unregistered paths
app.all('*', (req: Request, res: Response, next: NextFunction) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Centralized Global Error Handler Middleware
app.use(errorHandler);

// Start the server
const server = app.listen(config.port, () => {
  console.log(`[Server] Running in ${config.env} mode on port ${config.port}`);
});

// Handle unhandled promise rejections gracefully
process.on('unhandledRejection', (err: any) => {
  console.error('[UNHANDLED REJECTION] Shutting down server gracefully...');
  console.error(err.name, err.message);
  server.close(() => {
    process.exit(1);
  });
});

// Graceful shutdown on SIGTERM (e.g. from PM2, Docker, systemd)
const gracefulShutdown = (signal: string) => {
  console.log(`[Server] ${signal} received — starting graceful shutdown...`);
  server.close(async () => {
    console.log('[Server] HTTP server closed — draining MongoDB connections...');
    try {
      await mongoose.connection.close();
      console.log('[Database] MongoDB connection closed cleanly.');
    } catch (err) {
      console.error('[Database] Error closing MongoDB connection:', err);
    }
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  });

  // Force exit after 30 seconds if still not shut down
  setTimeout(() => {
    console.error('[Server] Forced shutdown after 30s timeout.');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
