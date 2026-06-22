import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import config from './config';
import connectDB from './config/db';
import apiRoutes from './routes';
import productRoutes from './routes/product.routes';
import adminRoutes from './routes/admin';
import errorHandler from './middleware/errorHandler';
import AppError from './utils/appError';

// Handle uncaught exceptions before any other code executes
process.on('uncaughtException', (err: Error) => {
  console.error('[UNCAUGHT EXCEPTION] Shutting down server...');
  console.error(err.name, err.message, err.stack);
  process.exit(1);
});

// Initialize Express app
const app = express();

// Connect to MongoDB Database
connectDB();

// Global Middleware Stack
app.use(helmet()); // Security headers

app.use(express.json({ limit: '10kb' })); // Body parser (capped to prevent payload injection)

// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// CORS configuration matching configured origins
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);

// Logging middleware
if (config.env === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Base legacy health/status endpoint for backward compatibility
app.get('/api/status', (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Solatide Biosciences API is running successfully',
    timestamp: new Date().toISOString(),
    env: config.env,
  });
});

// Register Direct and Versioned API Routes
app.use('/api/products', productRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/v1', apiRoutes);

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
