import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

mongoose.connect(process.env.MONGODB_URI!)
  .then(async () => {
    const Order = mongoose.connection.collection('orders');
    const recentOrder = await Order.find().sort({ createdAt: -1 }).limit(1).toArray();
    console.log(JSON.stringify(recentOrder, null, 2));
    process.exit(0);
  })
  .catch(err => console.error(err));
