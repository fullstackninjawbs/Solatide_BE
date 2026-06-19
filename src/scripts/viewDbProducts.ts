import mongoose from 'mongoose';
import Product from '../models/product.model';
import config from '../config';

const checkDb = async () => {
  try {
    await mongoose.connect(config.mongoUri || 'mongodb://127.0.0.1:27017/solatide');
    console.log('Connected to DB');
    const count = await Product.countDocuments();
    console.log(`Total Products in DB: ${count}`);
    const products = await Product.find().select('name id sku slug price').limit(10);
    console.log('Sample Products:', JSON.stringify(products, null, 2));
    process.exit(0);
  } catch (err: any) {
    console.error('Error:', err);
    process.exit(1);
  }
};

checkDb();
