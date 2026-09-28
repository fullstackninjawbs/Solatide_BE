import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI as string);
  const Order = require('./src/models/order.model.ts').default;
  const order = await Order.findOne({ orderNumber: 'SLT9523934B' });
  if (order) {
    console.log('shippingAddressObj:', order.shippingAddressObj);
    console.log('shippingAddress:', order.shippingAddress);
    console.log('customer:', order.customer);
    console.log('lineItems:', order.lineItems);
  } else {
    console.log('Order not found');
  }
  process.exit(0);
};

run();
