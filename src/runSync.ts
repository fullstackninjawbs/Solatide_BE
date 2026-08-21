import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { syncAllTagadaProducts } from './services/tagadaProductSync.service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI as string);
  console.log('Running Tagada Sync...');
  const adminId = new mongoose.Types.ObjectId();
  const result = await syncAllTagadaProducts(adminId);
  console.log('Sync Complete. Updated:', result.updatedCount);
  
  const Product = require('./models/product.model').default;
  const count = await Product.countDocuments({ tagadaVariantId: { $exists: true, $ne: '' } });
  console.log('Products with tagadaVariantId at root:', count);
  process.exit(0);
}

run();
