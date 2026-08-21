import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI as string);
  const TagadaProductSyncLog = require('./models/tagadaProductSyncLog.model').default;
  const latestLog = await TagadaProductSyncLog.findOne().sort({ startedAt: -1 });
  if (!latestLog) {
    console.log('No logs found.');
    process.exit(0);
  }
  console.log('Latest Sync Log:');
  console.log('Total Fetched:', latestLog.totalFetched);
  console.log('Created:', latestLog.createdCount);
  console.log('Updated:', latestLog.updatedCount);
  console.log('Failed:', latestLog.failedCount);
  
  // See how many were skipped vs updated
  const updatedCount = latestLog.changes.filter((c:any) => c.action === 'updated').length;
  const skippedCount = latestLog.changes.filter((c:any) => c.action === 'skipped').length;
  console.log('Changes breakdown:', { updated: updatedCount, skipped: skippedCount });
  
  process.exit(0);
}

run();
