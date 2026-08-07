import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: 'd:/Clients/Solatide/Server/.env' });

import Order from '../src/models/order.model';
import { initializeTagadaClientFromDB, getTagadaClient } from '../src/services/tagadaClient';
import PaymentSettings from '../src/models/PaymentSettings';

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("No MONGO_URI found in env");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");
  
  await initializeTagadaClientFromDB();

  const order = await Order.findOne({ tagadaOrderId: 'order_12cfbc321811' });
  if (!order) {
    console.log("Order not found with tagadaOrderId = order_12cfbc321811");
    
    // Try finding the most recent tagada order
    const latestOrder = await Order.findOne({ paymentMethod: 'tagada' }).sort({ createdAt: -1 });
    if (!latestOrder) {
       console.log("No tagada orders found at all");
       process.exit(1);
    }
    console.log("Falling back to latest Tagada order: " + latestOrder._id + " (Tagada ID: " + latestOrder.tagadaOrderId + ")");
    await syncOrder(latestOrder);
  } else {
    await syncOrder(order);
  }

  mongoose.disconnect();
}

async function syncOrder(order: any) {
  try {
    const client = await getTagadaClient();
    const targetId = 'order_12cfbc321811';
    
    console.log(`Fetching details for Tagada ID: ${targetId}...`);
    
    let res;
    if (targetId.startsWith('cs_')) {
      res = await client.checkout.retrieveSession(targetId);
    } else {
      res = await client.orders.retrieve(targetId);
    }
    
    const fullOrder = res.order || res.session || res;
    
    if (fullOrder) {
      if (fullOrder.customer) {
        order.customer = {
          firstName: fullOrder.customer.firstName || fullOrder.customer.first_name || '',
          lastName: fullOrder.customer.lastName || fullOrder.customer.last_name || '',
          email: fullOrder.customer.email || '',
          phone: fullOrder.customer.phone || undefined,
        };
        order.customerEmail = order.customer.email;
        order.customerName = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ');
      }
      
      const sa = fullOrder.shippingAddress || fullOrder.shipping_address || fullOrder.customer?.shippingAddress;
      if (sa) {
        order.shippingAddressObj = {
          name: sa.name || `${sa.firstName || ''} ${sa.lastName || ''}`.trim(),
          company: sa.company,
          street1: sa.address1 || sa.line1,
          street2: sa.address2 || sa.line2,
          city: sa.city,
          state: sa.province || sa.state,
          zip: sa.zip || sa.postalCode || sa.postal,
          country: sa.country,
        };
      }
      
      const ba = fullOrder.billingAddress || fullOrder.billing_address || fullOrder.customer?.billingAddress;
      if (ba) {
        order.billingAddressObj = {
          name: ba.name || `${ba.firstName || ''} ${ba.lastName || ''}`.trim(),
          company: ba.company,
          street1: ba.address1 || ba.line1,
          street2: ba.address2 || ba.line2,
          city: ba.city,
          state: ba.province || ba.state,
          zip: ba.zip || ba.postalCode || ba.postal,
          country: ba.country,
        };
      }
      
      await order.save({ validateBeforeSave: false });
      console.log("Order updated successfully in the database!");
    } else {
      console.log("Failed to fetch full order from Tagada");
    }
  } catch (err: any) {
    console.error("Error updating order:", err.message || err);
  }
}

main().catch(console.error);
