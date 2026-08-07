import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: 'd:/Clients/Solatide/Server/.env' });

import Order from '../src/models/order.model';

async function main() {
  await mongoose.connect(process.env.MONGO_URI as string);
  console.log("Connected to MongoDB");

  const latestOrder = await Order.findOne({}).sort({ createdAt: -1 });
  if (!latestOrder) {
     console.log("No orders found");
     process.exit(1);
  }
  console.log("Latest Order ID:", latestOrder._id);
  console.log("Created At:", latestOrder.createdAt);
  console.log("Payment Status:", latestOrder.paymentStatus);
  console.log("Customer:", latestOrder.customer);
  console.log("Customer Email:", latestOrder.customerEmail);

  mongoose.disconnect();
}

main().catch(console.error);
