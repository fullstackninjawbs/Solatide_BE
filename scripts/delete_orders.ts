import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: 'd:/Clients/Solatide/Server/.env' });

import Order from '../src/models/order.model';

async function main() {
  await mongoose.connect(process.env.MONGO_URI as string);
  console.log("Connected to MongoDB");

  // Find all orders
  const orders = await Order.find({});
  console.log(`Total orders found: ${orders.length}`);

  let deletedCount = 0;
  for (const order of orders) {
    const customerObjName = (order.customer?.firstName || '') + ' ' + (order.customer?.lastName || '');
    const legacyName = order.customerName || '';
    const hasName = customerObjName.trim() !== '' || legacyName.trim() !== '';

    // If no name, delete it
    if (!hasName) {
      // Don't delete admin manual orders just in case
      if (order.source === 'admin_manual') {
        console.log(`Skipping admin order ${order._id} even though it has no name.`);
        continue;
      }
      
      console.log(`Deleting order ${order._id} because it has no customer name.`);
      await Order.findByIdAndDelete(order._id);
      deletedCount++;
    }
  }

  console.log(`Successfully deleted ${deletedCount} orders without customer names.`);

  mongoose.disconnect();
}

main().catch(console.error);
