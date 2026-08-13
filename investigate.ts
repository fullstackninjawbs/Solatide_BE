import mongoose from 'mongoose';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/solatide');
    const db = mongoose.connection.db!;

    const orderNumber = 'SLT8051978B';
    const order = await db.collection('orders').findOne({ orderNumber });

    if (!order) {
      console.log('Order not found in DB:', orderNumber);
      process.exit(1);
    }

    console.log('--- MongoDB Order Info ---');
    console.log('shippingMethodName:', order.shippingMethodName);
    console.log('shippingAddressObj.country:', order.shippingAddressObj?.country);
    console.log('starshipitOrderId:', order.starshipitOrderId);
    
    // Normalize logic replica
    const country = order.shippingAddressObj?.country?.toUpperCase() || 'AU';
    let normalized = order.shippingMethodName || '';
    if (country !== 'AU' && normalized) {
      if (normalized.startsWith('Standard - $')) normalized = 'Standard';
      if (normalized.startsWith('Express - $')) normalized = 'Express';
    }
    console.log('Normalized Value Expected:', normalized);

    console.log('\n--- Fetching from Starshipit ---');
    const apiKey = process.env.STARSHIPIT_API_KEY;
    const subscriptionKey = process.env.STARSHIPIT_SUBSCRIPTION_KEY;
    
    const headers = {
      'StarShipIT-Api-Key': apiKey || '',
      'Ocp-Apim-Subscription-Key': subscriptionKey || '',
      'Content-Type': 'application/json'
    };

    let starshipitOrder = null;
    
    if (order.starshipitOrderId) {
        const res2 = await axios.get(`https://api.starshipit.com/api/orders?order_id=${order.starshipitOrderId}`, { headers });
        if(res2.data.errors) console.log('Errors:', res2.data.errors);
        starshipitOrder = res2.data.order || (res2.data.orders && res2.data.orders[0]);
    } else {
        const response = await axios.get(`https://api.starshipit.com/api/orders?order_number=${orderNumber}`, { headers });
        if (response.data && response.data.orders && response.data.orders.length > 0) {
            starshipitOrder = response.data.orders[0];
        } else {
            console.log('Search response:', JSON.stringify(response.data, null, 2));
        }
    }

    if (starshipitOrder) {
      console.log('\n--- Starshipit Order Data ---');
      console.log('Carrier:', starshipitOrder.carrier);
      console.log('Carrier Name:', starshipitOrder.carrier_name);
      console.log('Carrier Service Code:', starshipitOrder.carrier_service_code);
      console.log('Shipping Method:', starshipitOrder.shipping_method);
      console.log('Status:', starshipitOrder.status);
    } else {
      console.log('Order not found in Starshipit via search.');
    }

  } catch (err: any) {
    console.error('Error:', err.response?.data || err.message);
  } finally {
    process.exit(0);
  }
}

run();
