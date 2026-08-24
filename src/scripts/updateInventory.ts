import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import Product from '../models/product.model';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI as string);
    console.log('Connected to DB.');

    // Fetch all products
    const products = await Product.find({});
    let updatedCount = 0;

    for (const product of products) {
      product.stockQuantity = 15;
      product.inStock = true;

      if (product.variants && product.variants.length > 0) {
        for (const variant of product.variants) {
          variant.stockQty = 15;
        }
      }

      await product.save();
      updatedCount++;
    }

    console.log(`Successfully updated inventory for ${updatedCount} products.`);
  } catch (err: any) {
    console.error('Error updating inventory:', err.message);
  } finally {
    process.exit(0);
  }
}

run();
