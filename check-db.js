require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const db = mongoose.connection.db;
    const orders = await db.collection('orders').find({}).toArray();
    console.log(`Total orders in DB: ${orders.length}`);
    orders.forEach(o => {
      console.log(`Order ID: ${o._id}, Status: ${o.status}, PaymentStatus: ${o.paymentStatus}, TagadaSession: ${o.tagadaPaymentId}, TagadaOrderId: ${o.tagadaOrderId}`);
    });
  } catch (err) {
    console.error(err);
  } finally {
    mongoose.disconnect();
  }
}
run();
