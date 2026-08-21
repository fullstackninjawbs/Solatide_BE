import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI as string);
  const Product = require('./models/product.model').default;
  const count = await Product.countDocuments({ tagadaVariantId: { $exists: true, $ne: '' } });
  console.log('Products with tagadaVariantId at root:', count);
  const vCount = await Product.countDocuments({ 'variants.0.tagadaVariantId': { $exists: true, $ne: '' } });
  console.log('Products with tagadaVariantId in variants:', vCount);
  process.exit(0);
}

run();
