import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import Product from './models/product.model';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI as string);
  const indexes = await Product.collection.indexes();
  console.log(indexes);
  
  // Find products with empty sku
  const emptySkus = await Product.countDocuments({ sku: "" });
  console.log('Products with empty sku:', emptySkus);
  
  process.exit(0);
}

run();
