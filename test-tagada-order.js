const { TagadaPay } = require('@tagadapay/node-sdk');
require('dotenv').config();

const tagada = new TagadaPay({
  apiKey: process.env.TAGADA_API_KEY,
  storeId: process.env.TAGADA_STORE_ID
});

async function run() {
  try {
    // 1. Fetch order
    const order = await tagada.orders.retrieve('12836409049254');
    console.log("=== ORDER ===");
    console.log(JSON.stringify(order, null, 2));

    // 2. Fetch payments
    const payments = await tagada.payments.list({ filters: { orderId: '12836409049254' } });
    console.log("=== PAYMENTS ===");
    console.log(JSON.stringify(payments, null, 2));
  } catch (err) {
    console.error(err);
  }
}

run();
