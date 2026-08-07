import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: 'd:/Clients/Solatide/Server/.env' });
import Order from '../src/models/order.model';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log("Connected to MongoDB");

  const order = await Order.findOne({ paymentMethod: 'tagada' }).sort({ createdAt: -1 }).lean();
  if (order) {
    console.log("LATEST TAGADA ORDER:");
    console.log("ID:", order._id);
    console.log("Tagada ID:", order.tagadaOrderId);
    console.log("Customer:", order.customer);
    console.log("Shipping Address Obj:", order.shippingAddressObj);
    console.log("Line Items:", order.lineItems);
  } else {
    console.log("No Tagada orders found.");
  }

  mongoose.disconnect();
}
main().catch(console.error);
