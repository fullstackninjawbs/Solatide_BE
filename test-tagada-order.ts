import { Tagada } from '@tagadapay/node-sdk';
import dotenv from 'dotenv';
dotenv.config();

const tagada = new Tagada({
  apiKey: process.env.TAGADA_API_KEY!
});

async function run() {
  try {
    const order = await tagada.orders.retrieve('12836409049254');
    console.log("=== ORDER ===");
    console.log(JSON.stringify(order, null, 2));
    
    const payments = await tagada.payments.list({ filters: { orderId: '12836409049254' } });
    console.log("=== PAYMENTS ===");
    console.log(JSON.stringify(payments, null, 2));
  } catch (err) {
    console.error(err);
  }
}

run();
