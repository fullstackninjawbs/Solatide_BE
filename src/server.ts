import mongoose from 'mongoose';
import config from './config';
import connectDB from './config/db';
import app from './app';
import { initializeTagadaClientFromDB } from './services/tagadaClient';
import { enableStorefrontAutoRebuild } from './utils/storefrontRebuildHooks';

// Product/batch/collection/FAQ changes refresh the prerendered storefront — only in the API process.
enableStorefrontAutoRebuild();

// Handle uncaught exceptions
process.on('uncaughtException', (err: Error) => {
  console.error('[UNCAUGHT EXCEPTION] Shutting down server...');
  console.error(err.name, err.message, err.stack);
  process.exit(1);
});

// Connect to MongoDB Database and initialize DB-backed singletons
connectDB().then(() => {
  initializeTagadaClientFromDB();
});

// Start the server
const server = app.listen(config.port, () => {
  console.log(`[Server] Running in ${config.env} mode on port ${config.port}`);
});

// Request/header timeouts (slowloris / hung upstream protection)
server.requestTimeout = 30000;
server.headersTimeout = 35000; // must exceed keepAliveTimeout
server.keepAliveTimeout = 5000;

// PM2 kills the process after kill_timeout (15s, see ecosystem.config.js); keep the
// forced exit below that so we exit on our own terms.
const FORCE_EXIT_MS = 12000;
let shuttingDown = false;

const gracefulShutdown = (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal} received — starting graceful shutdown...`);

  setTimeout(() => {
    console.error(`[Server] Forced shutdown after ${FORCE_EXIT_MS / 1000}s timeout.`);
    process.exit(1);
  }, FORCE_EXIT_MS).unref();

  server.close(async () => {
    console.log('[Server] HTTP server closed — draining MongoDB connections...');
    try {
      await mongoose.connection.close();
      console.log('[Database] MongoDB connection closed cleanly.');
    } catch (err) {
      console.error('[Database] Error closing MongoDB connection:', err);
    }
    console.log('[Server] Shutdown complete.');
    process.exit(exitCode);
  });
  // Close idle keep-alive sockets so server.close() can complete
  server.closeIdleConnections?.();
};

// Handle unhandled promise rejections gracefully
process.on('unhandledRejection', (err: any) => {
  console.error('[UNHANDLED REJECTION] Shutting down server gracefully...');
  console.error(err?.name, err?.message);
  gracefulShutdown('unhandledRejection', 1);
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// PM2 (cluster mode / Windows) may send a 'shutdown' message instead of a signal
process.on('message', (msg: unknown) => {
  if (msg === 'shutdown') gracefulShutdown('shutdown');
});
