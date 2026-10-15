/**
 * Standalone background worker (optional). Use when RUN_WORKERS=separate, as its own PM2 app:
 *   pm2 start dist/worker.js --name solatide-worker
 * By default (RUN_WORKERS=api) the first API instance runs the workers and this is not needed.
 */
import mongoose from 'mongoose';
import './config';
import connectDB from './config/db';
import { initializeTagadaClientFromDB } from './services/tagadaClient';
import { enableStorefrontAutoRebuild } from './utils/storefrontRebuildHooks';
import { queuesEnabled } from './queues/connection';
import { startWorkers, stopWorkers } from './queues/workers';
import { closeQueues } from './queues/queues';
import { closeProducerConnection } from './queues/connection';

if (!queuesEnabled()) {
  console.error('[Worker] Queues are disabled (REDIS_URL=disabled, QUEUES_ENABLED=false or NODE_ENV=test). Exiting.');
  process.exit(1);
}

// Writes made by jobs (e.g. Tagada sync, stock) should refresh caches / request rebuilds too
enableStorefrontAutoRebuild();

connectDB().then(async () => {
  initializeTagadaClientFromDB();
  await startWorkers();
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[Worker] ${signal} received — stopping workers...`);
  setTimeout(() => process.exit(1), 12000).unref();
  await stopWorkers().catch(() => undefined);
  await closeQueues().catch(() => undefined);
  await closeProducerConnection().catch(() => undefined);
  await mongoose.connection.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('message', (msg: unknown) => { if (msg === 'shutdown') shutdown('shutdown'); });
