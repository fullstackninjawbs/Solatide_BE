require('dotenv').config();
const { TagadaPay } = require('@tagadapay/node-sdk/dist/index.js');
const tagada = new TagadaPay({ apiKey: process.env.TAGADA_API_KEY, storeId: process.env.TAGADA_STORE_ID });
async function run() {
  try {
    const session = await tagada.checkout.createSession({
      storeId: process.env.TAGADA_STORE_ID,
      items: [{ variantId: 'variant_5bff88ae722b', quantity: 1 }],
      currency: 'AUD',
      returnUrl: 'http://localhost/success',
      cartToken: 'TEST_ORDER_ID_123'
    });
    console.log("Success! Returning:", session);
  } catch (err) {
    console.error("Failed:", err.response?.data || err.message);
  }
}
run();
