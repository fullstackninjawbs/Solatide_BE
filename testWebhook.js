const mongoose = require('mongoose');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;
const WEBHOOK_SECRET = process.env.TAGADA_WEBHOOK_SECRET;
const PORT = process.env.PORT || 5000;

if (!MONGO_URI || !WEBHOOK_SECRET) {
  console.error('Error: MONGO_URI and TAGADA_WEBHOOK_SECRET must be set in your .env file.');
  process.exit(1);
}

// Order Schema stub for query
const orderSchema = new mongoose.Schema({
  paymentStatus: String,
  grandTotal: Number,
  customerEmail: String,
  customerName: String,
  products: Array
}, { strict: false });

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

async function run() {
  console.log('Connecting to database...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  // Find a pending order
  const order = await Order.findOne({ paymentStatus: 'pending' }).sort({ createdAt: -1 });

  if (!order) {
    console.log('No pending orders found to test with. Please create a draft order or storefront checkout order first.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found pending order: ${order._id} (Total: ${order.grandTotal}, Customer: ${order.customerEmail})`);

  // Construct mock Tagada payment payload
  const mockPayload = {
    type: 'payment/captured',
    event: 'payment.captured',
    data: {
      id: `mock_pay_${crypto.randomBytes(8).toString('hex')}`,
      status: 'captured',
      checkoutSessionId: order.tagadaPaymentId || `mock_sess_${crypto.randomBytes(8).toString('hex')}`,
      paymentId: `mock_pay_${crypto.randomBytes(8).toString('hex')}`,
      orderId: `mock_order_${crypto.randomBytes(8).toString('hex')}`,
      session_id: `mock_sess_${crypto.randomBytes(8).toString('hex')}`,
      cartToken: order._id.toString(),
      externalOrderId: order._id.toString(),
      amount: Math.round((order.grandTotal || 100) * 100),
      currency: 'AUD',
      customer: {
        first_name: order.customerName ? order.customerName.split(' ')[0] : 'Test',
        last_name: order.customerName ? order.customerName.split(' ').slice(1).join(' ') : 'User',
        email: order.customerEmail || 'test@solatide.com',
        phone: '0412345678'
      },
      shipping_address: {
        name: order.customerName || 'Test User',
        address1: '123 Test Street',
        city: 'Sydney',
        province: 'NSW',
        zip: '2000',
        country: 'Australia'
      },
      line_items: (order.products || []).map(p => ({
        title: 'Mock Product',
        quantity: p.quantity || 1,
        price: p.price || 10
      }))
    }
  };

  const payloadString = JSON.stringify(mockPayload);
  const rawBodyBuffer = Buffer.from(payloadString, 'utf8');

  // Compute HMAC signature
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBodyBuffer)
    .digest('hex');

  const webhookUrl = `http://localhost:${PORT}/api/payments/tagada/webhook`;
  console.log(`Sending webhook request to: ${webhookUrl}`);
  console.log(`x-tagadapay-signature: sha256=${signature}`);

  try {
    const response = await axios.post(webhookUrl, rawBodyBuffer, {
      headers: {
        'Content-Type': 'application/json',
        'x-tagadapay-signature': `sha256=${signature}`
      }
    });

    console.log('\n--- Webhook Response ---');
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log('Data:', response.data);
    console.log('------------------------\n');
    console.log('Success! Check your server console/logs to verify the order updated to "paid" and sent the email.');
  } catch (error) {
    console.error('Webhook request failed:', error.response ? error.response.data : error.message);
  } finally {
    await mongoose.disconnect();
  }
}

run().catch(console.error);
