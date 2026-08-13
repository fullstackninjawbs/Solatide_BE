import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Order } from './src/models/order.model';
import { starshipitService } from './src/services/shipping/starshipit.service';

dotenv.config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/solatide');
    console.log('Connected to DB');

    // TEST 1 — INTERNATIONAL STANDARD
    const testOrder = new Order({
      orderNumber: 'TEST-STD-' + Date.now(),
      customer: {
        firstName: 'International Standard Test',
        lastName: '',
        email: 'apprapidgrp@gmail.com',
        phone: '+64210000003'
      },
      customerEmail: 'apprapidgrp@gmail.com',
      shippingAddressObj: {
        name: 'International Standard Test',
        street1: '25 Queen Street',
        city: 'Auckland',
        state: 'Auckland Region',
        zip: '1010',
        country: 'NZ'
      },
      lineItems: [
        {
          title: 'KPV 10mg',
          quantity: 1,
          unitPrice: 100,
          subtotal: 100
        }
      ],
      subtotal: 100,
      shippingAmount: 11,
      grandTotal: 111,
      currency: 'NZD',
      shippingMethodName: 'Standard - $11.00',
      shippingMethodCode: 'Standard',
      status: 'processing',
      fulfilmentStatus: 'unfulfilled',
      paymentStatus: 'paid'
    });

    await testOrder.save();
    console.log('Saved order to DB:', testOrder.orderNumber);
    console.log('MongoDB shippingMethodName =', testOrder.shippingMethodName);

    // Create Shipment
    console.log('Creating shipment via Starshipit Service...');
    const shipmentResult = await starshipitService.createShipment({
      order: testOrder as any,
      origin: null,
      weightKg: 0.5
    });

    console.log('Shipment Result:', shipmentResult);
  } catch (error: any) {
    console.error('Error during test:', error.message);
  } finally {
    process.exit(0);
  }
}

run();
