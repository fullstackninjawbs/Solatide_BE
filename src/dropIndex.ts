import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import Product from './models/product.model';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI as string);
  console.log('Dropping sku_1 index...');
  try {
    await Product.collection.dropIndex('sku_1');
    console.log('Successfully dropped sku_1 index.');
  } catch (err: any) {
    console.log('Error dropping index:', err.message);
  }
  process.exit(0);
}

run();
