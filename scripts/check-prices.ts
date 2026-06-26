import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const productSchema = new mongoose.Schema({}, { strict: false });
const Product = mongoose.model('Product', productSchema, 'products');

async function test() {
  await mongoose.connect(process.env.MONGO_URI as string);
  const products = await Product.find({}, 'name price variants._id variants.price').lean();
  console.log(JSON.stringify(products.slice(0, 3), null, 2));
  mongoose.disconnect();
}
test();
