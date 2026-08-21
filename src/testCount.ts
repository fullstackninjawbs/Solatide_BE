import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI as string);
  const Product = require('./models/product.model').default;
  const count = await Product.countDocuments();
  console.log('Total Products:', count);
  const matched = await Product.countDocuments({ tagadaProductId: { $exists: true, $ne: '' } });
  console.log('Products with tagadaProductId:', matched);
  process.exit(0);
}

run();
