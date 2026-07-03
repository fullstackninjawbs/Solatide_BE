require('dotenv').config();
const { TagadaPay } = require('@tagadapay/node-sdk');
const tagada = new TagadaPay({ apiKey: process.env.TAGADA_API_KEY, storeId: process.env.TAGADA_STORE_ID });
async function run() {
  try {
    const session = await tagada.checkout.createSession({
      storeId: process.env.TAGADA_STORE_ID,
      items: [{ variantId: 'test', quantity: 1 }],
      currency: 'AUD',
      returnUrl: 'http://localhost/success'
    });
    console.log("Create Session Result:");
    console.log(session);
  } catch (err) {
    console.error(err.message);
  }
}
run();
