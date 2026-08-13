import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/solatide');
  const db = mongoose.connection.db;
  const orders = await db.collection('orders').find({}).sort({createdAt: -1}).limit(20).toArray();
  for (const order of orders) {
    console.log(order.orderNumber, '||', order.shippingMethodName, '||', order.shippingMethodCode);
  }
  process.exit(0);
}
run();
