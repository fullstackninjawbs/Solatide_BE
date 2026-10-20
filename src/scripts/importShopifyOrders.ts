import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import csv from 'csv-parser';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from '../models/order.model';
import Customer from '../models/Customer';
import Product from '../models/product.model';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface CsvRow {
  [key: string]: string;
}

interface ParsedLineItem {
  title: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  product?: mongoose.Types.ObjectId;
}

interface ParsedOrder {
  orderNumber: string;
  email: string;
  customerName: string;
  firstName: string;
  lastName: string;
  phone: string;
  shippingAddressObj: any;
  billingAddressObj: any;
  lineItems: ParsedLineItem[];
  subtotal: number;
  shippingAmount: number;
  taxAmount: number;
  discountAmount: number;
  couponCode?: string;
  grandTotal: number;
  currency: string;
  shippingMethodName: string;
  paymentMethod: string;
  paymentStatus: 'pending' | 'paid' | 'failed' | 'cancelled' | 'partially_refunded' | 'refunded';
  fulfilmentStatus: 'unfulfilled' | 'fulfilled' | 'partial';
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  paidAt?: Date | null;
  createdAt: Date;
  tags: string[];
  notes: string;
  tagadaOrderId?: string;
}

function cleanZip(zip?: string): string {
  if (!zip) return '';
  return zip.trim().replace(/^'/, '');
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = (fullName || '').trim().split(/\s+/);
  if (parts.length === 0 || (parts.length === 1 && !parts[0])) {
    return { firstName: '', lastName: '' };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

export async function parseShopifyOrdersCsv(filePath: string): Promise<Map<string, ParsedOrder>> {
  const orders = new Map<string, ParsedOrder>();

  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row: CsvRow) => {
        const rawName = (row['Name'] || '').trim();
        if (!rawName) return;

        const orderNumber = rawName.replace(/^#/, '');

        if (!orders.has(orderNumber)) {
          const email = (row['Email'] || '').trim().toLowerCase();
          const shippingName = (row['Shipping Name'] || '').trim();
          const billingName = (row['Billing Name'] || '').trim();
          const customerName = shippingName || billingName || 'Customer';
          const { firstName, lastName } = splitName(customerName);

          const phone = (row['Shipping Phone'] || row['Billing Phone'] || row['Phone'] || '').trim();

          const shippingAddressObj = {
            name: shippingName || customerName,
            company: (row['Shipping Company'] || '').trim(),
            street1: (row['Shipping Address1'] || row['Shipping Street'] || '').trim(),
            street2: (row['Shipping Address2'] || '').trim(),
            city: (row['Shipping City'] || '').trim(),
            state: (row['Shipping Province'] || '').trim(),
            zip: cleanZip(row['Shipping Zip']),
            country: (row['Shipping Country'] || 'AU').trim(),
            phone: (row['Shipping Phone'] || phone).trim(),
          };

          const billingAddressObj = {
            name: billingName || customerName,
            company: (row['Billing Company'] || '').trim(),
            street1: (row['Billing Address1'] || row['Billing Street'] || '').trim(),
            street2: (row['Billing Address2'] || '').trim(),
            city: (row['Billing City'] || '').trim(),
            state: (row['Billing Province'] || '').trim(),
            zip: cleanZip(row['Billing Zip']),
            country: (row['Billing Country'] || 'AU').trim(),
            phone: (row['Billing Phone'] || phone).trim(),
          };

          const finStatus = (row['Financial Status'] || '').trim().toLowerCase();
          let paymentStatus: ParsedOrder['paymentStatus'] = 'pending';
          if (finStatus === 'paid') paymentStatus = 'paid';
          else if (finStatus === 'refunded') paymentStatus = 'refunded';
          else if (finStatus === 'partially_refunded') paymentStatus = 'partially_refunded';
          else if (finStatus === 'voided') paymentStatus = 'cancelled';

          const fulStatus = (row['Fulfillment Status'] || '').trim().toLowerCase();
          let fulfilmentStatus: ParsedOrder['fulfilmentStatus'] = 'unfulfilled';
          if (fulStatus === 'fulfilled') fulfilmentStatus = 'fulfilled';
          else if (fulStatus === 'partial') fulfilmentStatus = 'partial';

          const cancelledAt = (row['Cancelled at'] || '').trim();
          let status: ParsedOrder['status'] = 'processing';
          if (cancelledAt) {
            status = 'cancelled';
          } else if (fulfilmentStatus === 'fulfilled') {
            status = 'delivered';
          } else if (paymentStatus === 'paid') {
            status = 'processing';
          } else {
            status = 'pending';
          }

          const rawTags = (row['Tags'] || '').trim();
          const tags = rawTags
            ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
            : [];
          if (!tags.includes('shopify-import')) tags.push('shopify-import');

          const notes = (row['Notes'] || '').trim();
          let tagadaOrderId: string | undefined;
          const tagadaMatch = notes.match(/order_[a-f0-9]{12,}/i) || rawTags.match(/order_[a-f0-9]{12,}/i);
          if (tagadaMatch) {
            tagadaOrderId = tagadaMatch[0];
          }

          const subtotal = Math.round(parseFloat(row['Subtotal'] || '0') * 100) / 100;
          const shippingAmount = Math.round(parseFloat(row['Shipping'] || '0') * 100) / 100;
          const taxAmount = Math.round(parseFloat(row['Taxes'] || '0') * 100) / 100;
          const discountAmount = Math.round(parseFloat(row['Discount Amount'] || '0') * 100) / 100;
          const grandTotal = Math.round(parseFloat(row['Total'] || '0') * 100) / 100;

          const createdAt = row['Created at'] ? new Date(row['Created at']) : new Date();
          const paidAt = row['Paid at'] ? new Date(row['Paid at']) : (paymentStatus === 'paid' ? createdAt : null);

          orders.set(orderNumber, {
            orderNumber,
            email,
            customerName,
            firstName,
            lastName,
            phone,
            shippingAddressObj,
            billingAddressObj,
            lineItems: [],
            subtotal,
            shippingAmount,
            taxAmount,
            discountAmount,
            couponCode: (row['Discount Code'] || '').trim() || undefined,
            grandTotal,
            currency: (row['Currency'] || 'AUD').trim(),
            shippingMethodName: (row['Shipping Method'] || '').trim(),
            paymentMethod: (row['Payment Method'] || 'TagadaPay').trim(),
            paymentStatus,
            fulfilmentStatus,
            status,
            paidAt,
            createdAt,
            tags,
            notes,
            tagadaOrderId,
          });
        }

        const ord = orders.get(orderNumber)!;
        const lineItemName = (row['Lineitem name'] || '').trim();
        if (lineItemName) {
          const qty = parseInt(row['Lineitem quantity'] || '1', 10) || 1;
          const unitPrice = parseFloat(row['Lineitem price'] || '0') || 0;
          const sku = (row['Lineitem sku'] || '').trim();

          ord.lineItems.push({
            title: lineItemName,
            sku,
            quantity: qty,
            unitPrice,
            subtotal: Math.round(qty * unitPrice * 100) / 100,
          });
        }
      })
      .on('end', () => resolve())
      .on('error', (err) => reject(err));
  });

  return orders;
}

export async function importShopifyOrders(options: {
  filePath: string;
  commit?: boolean;
  mongoUri?: string;
}): Promise<void> {
  const { filePath, commit = false, mongoUri: customMongoUri } = options;

  console.log(`\n======================================================`);
  console.log(` Shopify Order & Customer History Import`);
  console.log(` Mode: ${commit ? '🔴 LIVE COMMIT' : '🟡 DRY RUN (no database changes)'}`);
  console.log(` File: ${filePath}`);
  console.log(`======================================================\n`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const mongoUri = customMongoUri || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is not set in environment or passed via --uri.');
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB.\n');

  console.log('Parsing CSV...');
  const parsedOrdersMap = await parseShopifyOrdersCsv(filePath);
  const parsedOrders = Array.from(parsedOrdersMap.values());
  console.log(`Parsed ${parsedOrders.length} distinct orders.\n`);

  // Build product SKU / name lookup
  const allProducts = await Product.find({}).select('sku name variants').lean();
  const skuToProduct = new Map<string, mongoose.Types.ObjectId>();
  const nameToProduct = new Map<string, mongoose.Types.ObjectId>();

  for (const p of allProducts) {
    const pid = p._id as mongoose.Types.ObjectId;
    if (p.sku) skuToProduct.set(p.sku.trim().toLowerCase(), pid);
    if (p.name) nameToProduct.set(p.name.trim().toLowerCase(), pid);
    if (Array.isArray(p.variants)) {
      for (const v of p.variants) {
        if (v.sku) skuToProduct.set(v.sku.trim().toLowerCase(), pid);
      }
    }
  }

  // Check existing orders in DB
  const existingOrderNumbers = new Set(
    (
      await Order.find({ orderNumber: { $in: parsedOrders.map((o) => o.orderNumber) } })
        .select('orderNumber')
        .lean()
    ).map((o) => o.orderNumber)
  );

  let newOrdersCount = 0;
  let skippedOrdersCount = 0;
  let totalImportSales = 0;
  const customersMap = new Map<string, {
    name: string;
    phone: string;
    address: any;
    orders: ParsedOrder[];
  }>();

  for (const ord of parsedOrders) {
    if (existingOrderNumbers.has(ord.orderNumber)) {
      skippedOrdersCount++;
      continue;
    }

    newOrdersCount++;
    totalImportSales += ord.grandTotal;

    // Link line items to catalog products where matched
    for (const item of ord.lineItems) {
      const match =
        (item.sku && skuToProduct.get(item.sku.toLowerCase())) ||
        nameToProduct.get(item.title.toLowerCase());
      if (match) item.product = match;
    }

    // Customer aggregation
    if (ord.email) {
      if (!customersMap.has(ord.email)) {
        customersMap.set(ord.email, {
          name: ord.customerName,
          phone: ord.phone,
          address: ord.shippingAddressObj,
          orders: [],
        });
      }
      const cData = customersMap.get(ord.email)!;
      cData.orders.push(ord);
      if (!cData.phone && ord.phone) cData.phone = ord.phone;
      if (!cData.name && ord.customerName) cData.name = ord.customerName;
    }
  }

  console.log(`Summary of Orders to Import:`);
  console.log(`  - New orders: ${newOrdersCount}`);
  console.log(`  - Already existing (skipped): ${skippedOrdersCount}`);
  console.log(`  - Total revenue to record: $${totalImportSales.toFixed(2)} AUD`);
  console.log(`  - Unique customers affected: ${customersMap.size}\n`);

  if (!commit) {
    console.log(`🟡 DRY RUN COMPLETE. No data was written to the database.`);
    console.log(`To commit this import, re-run with: --commit\n`);
    await mongoose.disconnect();
    return;
  }

  // ─── COMMIT PHASE ─────────────────────────────────────────────────────────────
  console.log(`Inserting ${newOrdersCount} orders...`);
  let insertedCount = 0;

  for (const ord of parsedOrders) {
    if (existingOrderNumbers.has(ord.orderNumber)) continue;

    const publicAccessToken = crypto.randomBytes(32).toString('hex');

    await Order.create({
      orderNumber: ord.orderNumber,
      publicAccessToken,
      customer: {
        firstName: ord.firstName,
        lastName: ord.lastName,
        email: ord.email,
        phone: ord.phone,
      },
      customerEmail: ord.email,
      customerName: ord.customerName,
      shippingAddressObj: ord.shippingAddressObj,
      billingAddressObj: ord.billingAddressObj,
      lineItems: ord.lineItems,
      products: ord.lineItems.map((li) => ({
        product: li.product,
        sku: li.sku,
        title: li.title,
        price: li.unitPrice,
        quantity: li.quantity,
      })),
      subtotal: ord.subtotal,
      shippingAmount: ord.shippingAmount,
      taxAmount: ord.taxAmount,
      discountAmount: ord.discountAmount,
      couponCode: ord.couponCode,
      grandTotal: ord.grandTotal,
      totalAmount: ord.grandTotal,
      currency: ord.currency,
      shippingMethodName: ord.shippingMethodName,
      paymentMethod: ord.paymentMethod.toLowerCase().includes('tagada') ? 'tagada' : 'manual_offline',
      paymentStatus: ord.paymentStatus,
      fulfilmentStatus: ord.fulfilmentStatus,
      status: ord.status,
      paidAt: ord.paidAt,
      createdAt: ord.createdAt,
      updatedAt: ord.createdAt,
      tags: ord.tags,
      adminNotes: ord.notes,
      tagadaOrderId: ord.tagadaOrderId,
      source: 'storefront',
      suppressConfirmationEmail: true,
      inventoryDecrementedAt: ord.createdAt, // Do not trigger low-stock alerts or double inventory decrements for historical orders
    });

    insertedCount++;
    if (insertedCount % 50 === 0 || insertedCount === newOrdersCount) {
      console.log(`  - Inserted ${insertedCount}/${newOrdersCount} orders...`);
    }
  }

  console.log(`\nUpdating customer records and history...`);
  let customersUpdated = 0;
  let customersCreated = 0;

  for (const [email, cData] of customersMap.entries()) {
    // Re-query ALL orders in DB for this customer to get exact aggregate metrics
    const customerOrders = await Order.find({
      $or: [{ customerEmail: email }, { 'customer.email': email }],
      isDeleted: { $ne: true },
    }).select('grandTotal paymentStatus').lean();

    const orderCount = customerOrders.length;
    const totalSpent = customerOrders
      .filter((o) => ['paid', 'partially_refunded', 'refunded'].includes(o.paymentStatus))
      .reduce((sum, o) => sum + (o.grandTotal || 0), 0);

    const existingCustomer = await Customer.findOne({ email });

    if (existingCustomer) {
      existingCustomer.orderCount = orderCount;
      existingCustomer.totalSpent = Math.round(totalSpent * 100) / 100;
      if (!existingCustomer.phone && cData.phone) existingCustomer.phone = cData.phone;
      if (!existingCustomer.defaultAddress && cData.address) existingCustomer.defaultAddress = cData.address;
      if (!existingCustomer.tags.includes('shopify-import')) {
        existingCustomer.tags.push('shopify-import');
      }
      await existingCustomer.save();
      customersUpdated++;
    } else {
      await Customer.create({
        name: cData.name || 'Customer',
        email,
        phone: cData.phone,
        defaultAddress: cData.address,
        country: 'Australia',
        orderCount,
        totalSpent: Math.round(totalSpent * 100) / 100,
        tags: ['shopify-import'],
        banned: false,
        comments: [
          {
            text: `Imported from Shopify historical order archive (${cData.orders.length} orders).`,
            createdAt: new Date(),
          },
        ],
      });
      customersCreated++;
    }
  }

  console.log(`\n======================================================`);
  console.log(` ✅ SUCCESSFUL IMPORT COMPLETED`);
  console.log(`  - Orders Inserted: ${insertedCount}`);
  console.log(`  - Customers Created: ${customersCreated}`);
  console.log(`  - Customers Updated: ${customersUpdated}`);
  console.log(`  - Total Customers in History: ${customersMap.size}`);
  console.log(`======================================================\n`);

  await mongoose.disconnect();
}

// CLI runner
if (require.main === module) {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const uriArg = args.find((a) => a.startsWith('--uri='))?.replace(/^--uri=/, '');
  const filePathArg = args.find((a) => !a.startsWith('--'));

  let defaultPath = 'd:/Clients/Solatide/orders_export_1 (2).csv';
  if (!fs.existsSync(defaultPath)) {
    const localCandidate = path.resolve(process.cwd(), 'orders_export_1 (2).csv');
    if (fs.existsSync(localCandidate)) {
      defaultPath = localCandidate;
    }
  }

  const filePath = filePathArg || defaultPath;

  importShopifyOrders({ filePath, commit, mongoUri: uriArg })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Import failed with error:', err);
      process.exit(1);
    });
}
