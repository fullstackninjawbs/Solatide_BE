require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Order = require('./src/models/order.model').default;

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // Create a token
  const token = jwt.sign({ id: 'dummy_admin_id', role: 'admin' }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
  
  console.log("Mock Token Generated:", token);

  // simulate what getOrders does
  const limitNum = 50;
  const skip = 0;
  const filter = {};
  
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
    Order.countDocuments(filter),
  ]);

  console.log("Controller simulation result:");
  console.log(`Results: ${orders.length}, Total: ${total}`);
  
  mongoose.disconnect();
}
run();
