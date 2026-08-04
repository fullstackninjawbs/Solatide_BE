require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./src/models/order.model').default;

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to DB');
  
  const orderId = '6a71a19c7b2f34a2ff63d751';
  const order = await Order.findById(orderId);
  if (order) {
    order.addressValidation = {
      isValid: false,
      needsReview: true,
      validationMessage: 'Invalid Address: Unsupported region code: "AI".',
      checkedAt: new Date()
    };
    await order.save();
    console.log('Updated order with new needsReview state');
  } else {
    console.log('Order not found');
  }
  
  mongoose.disconnect();
}

run().catch(console.error);
