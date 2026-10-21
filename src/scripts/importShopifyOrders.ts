import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import csv from 'csv-parser';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Order from '../models/order.model';
import Customer from '../models/Customer';
import Product from '../models/product.model';
import User from '../models/user.model';
import { REVENUE_PAYMENT_STATUSES } from '../domain/revenue';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * importShopifyOrders.ts — insert historical orders from a Shopify "Export orders" CSV and
 * rebuild the affected customers' order count / total spent.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --commit is passed.
 *
 *   npx ts-node --transpile-only src/scripts/importShopifyOrders.ts "/path/orders_export.csv"            # report only
 *   npx ts-node --transpile-only src/scripts/importShopifyOrders.ts "/path/orders_export.csv" --commit   # insert
 *   options: --uri=mongodb://...  (default: MONGO_URI from .env)   --skip-voided  (leave voided orders out)
 *
 * INSERT-ONLY for orders: an order already in the database (same order number or same Tagada order
 * id) is skipped, so re-running is safe. Imported orders are history only: source 'shopify_import',
 * and every automatic step (paid side effects, abandoned reminder, shipment email, address check)
 * is marked as already done, so a late Tagada/Starshipit webhook or opening the order in the admin
 * never emails the customer, notifies the admin, or changes stock, coupons or customer totals.
 */

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
  productImageUrl?: string;
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
  fulfilledAt?: Date | null;
  refundedAmount: number;
  createdAt: Date;
  tags: string[];
  notes: string;
  tagadaOrderId?: string;
}

/** Shopify payment method text → our enum. */
export function mapPaymentMethod(raw: string): 'tagada' | 'payid' | 'bank_transfer' | 'manual_offline' {
  const m = (raw || '').toLowerCase();
  if (m.includes('tagada')) return 'tagada';
  if (m.includes('payid') || m.includes('osko')) return 'payid';
  if (m.includes('bank')) return 'bank_transfer';
  return 'manual_offline';
}

function validDate(raw?: string): Date | null {
  if (!raw || !raw.trim()) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

const money = (raw?: string): number => Math.round((parseFloat(raw || '0') || 0) * 100) / 100;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  const handleRow = (row: CsvRow) => {
    const rawName = (row['Name'] || '').trim();
    if (!rawName) return;

    const orderNumber = rawName.replace(/^#/, '');

    // Order-level fields come from the order's first row; later rows only add line items.
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
      // voided = the payment never went through (cancelled / failed attempt), so never "pending"
      if (cancelledAt || finStatus === 'voided') {
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

      // No usable order date → refuse the file (a "now" date would look like a brand-new order)
      const createdAt = validDate(row['Created at']);
      if (!createdAt) throw new Error(`Order ${orderNumber}: missing or invalid "Created at" (${row['Created at'] || 'empty'})`);
      const paidAt = validDate(row['Paid at'])
        || (REVENUE_PAYMENT_STATUSES.includes(paymentStatus) ? createdAt : null);

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
        subtotal: money(row['Subtotal']),
        shippingAmount: money(row['Shipping']),
        taxAmount: money(row['Taxes']),
        discountAmount: money(row['Discount Amount']),
        couponCode: (row['Discount Code'] || '').trim() || undefined,
        grandTotal: money(row['Total']),
        currency: (row['Currency'] || 'AUD').trim(),
        shippingMethodName: (row['Shipping Method'] || '').trim(),
        paymentMethod: (row['Payment Method'] || '').trim(),
        paymentStatus,
        fulfilmentStatus,
        status,
        paidAt,
        fulfilledAt: validDate(row['Fulfilled at']),
        refundedAmount: money(row['Refunded Amount']),
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
  };

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath).pipe(csv());
    stream
      .on('data', (row: CsvRow) => {
        try {
          handleRow(row);
        } catch (err) {
          stream.destroy();
          reject(err);
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
  skipVoided?: boolean;
}): Promise<void> {
  const { filePath, commit = false, mongoUri: customMongoUri, skipVoided = false } = options;

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

  console.log('Parsing CSV...');
  const allParsed = Array.from((await parseShopifyOrdersCsv(filePath)).values());
  const isVoided = (o: ParsedOrder) => o.paymentStatus === 'cancelled' && !o.paidAt;
  const voidedCount = allParsed.filter(isVoided).length;
  const parsedOrders = skipVoided ? allParsed.filter((o) => !isVoided(o)) : allParsed;
  console.log(`Parsed ${allParsed.length} distinct orders (${voidedCount} voided — ${skipVoided ? 'left out (--skip-voided)' : 'imported as cancelled'}).\n`);

  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  const { host, name: dbName } = mongoose.connection;
  console.log(`Connected to database "${dbName}" on ${host} — make sure this is the intended database.\n`);

  // Build product SKU / name / image lookup
  const allProducts = await Product.find({}).select('sku name variants imageUrl images').lean();
  const skuToProduct = new Map<string, mongoose.Types.ObjectId>();
  const nameToProduct = new Map<string, mongoose.Types.ObjectId>();
  const skuToImage = new Map<string, string>();
  const nameToImage = new Map<string, string>();

  for (const p of allProducts) {
    const pid = p._id as mongoose.Types.ObjectId;
    const img = p.imageUrl || p.images?.[0]?.url || p.images?.[0]?.secureUrl || '';
    if (p.sku) {
      const s = p.sku.trim().toLowerCase();
      skuToProduct.set(s, pid);
      if (img) skuToImage.set(s, img);
    }
    if (p.name) {
      const n = p.name.trim().toLowerCase();
      nameToProduct.set(n, pid);
      if (img) nameToImage.set(n, img);
    }
    if (Array.isArray(p.variants)) {
      for (const v of p.variants) {
        if (v.sku) {
          const vs = v.sku.trim().toLowerCase();
          skuToProduct.set(vs, pid);
          if (img) skuToImage.set(vs, img);
        }
      }
    }
  }

  // Already in the database: same order number, or same Tagada order id (e.g. synced from Tagada).
  // Skipping those also keeps every Tagada webhook matching exactly one order.
  const tagadaIds = parsedOrders.map((o) => o.tagadaOrderId).filter(Boolean) as string[];
  const existing = await Order.find({
    $or: [{ orderNumber: { $in: parsedOrders.map((o) => o.orderNumber) } }, { tagadaOrderId: { $in: tagadaIds } }],
  }).select('orderNumber tagadaOrderId').lean();
  const existingNumbers = new Set(existing.map((o) => o.orderNumber));
  const existingTagada = new Set(existing.map((o) => o.tagadaOrderId).filter(Boolean));
  const alreadyThere = (o: ParsedOrder) => existingNumbers.has(o.orderNumber) || (!!o.tagadaOrderId && existingTagada.has(o.tagadaOrderId));

  // Storefront accounts with the same email → link the order so it also shows in "My account"
  const emails = [...new Set(parsedOrders.map((o) => o.email).filter(Boolean))];
  const userByEmail = new Map(
    (await User.find({ email: { $in: emails } }).select('_id email').lean()).map((u: any) => [String(u.email).toLowerCase(), u._id])
  );

  let newOrdersCount = 0;
  let skippedOrdersCount = 0;
  let skippedByTagada = 0;
  let linkedToAccount = 0;
  let withoutEmail = 0;
  let totalImportSales = 0;
  const customersMap = new Map<string, {
    name: string;
    phone: string;
    address: any;
    orders: ParsedOrder[];
  }>();

  for (const ord of parsedOrders) {
    if (alreadyThere(ord)) {
      skippedOrdersCount++;
      if (!existingNumbers.has(ord.orderNumber)) skippedByTagada++;
      continue;
    }

    newOrdersCount++;
    if (REVENUE_PAYMENT_STATUSES.includes(ord.paymentStatus)) totalImportSales += ord.grandTotal - ord.refundedAmount;
    if (ord.email && userByEmail.has(ord.email)) linkedToAccount++;
    if (!ord.email) withoutEmail++;

    // Link line items to catalog products where matched
    for (const item of ord.lineItems) {
      const match =
        (item.sku && skuToProduct.get(item.sku.toLowerCase())) ||
        nameToProduct.get(item.title.toLowerCase());
      if (match) item.product = match;

      const img =
        (item.sku && skuToImage.get(item.sku.toLowerCase())) ||
        nameToImage.get(item.title.toLowerCase());
      if (img) item.productImageUrl = img;
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
  console.log(`  - Already existing (skipped): ${skippedOrdersCount}${skippedByTagada ? ` (${skippedByTagada} matched by Tagada order id)` : ''}`);
  console.log(`  - Net revenue to record (paid, minus refunds): $${totalImportSales.toFixed(2)} AUD`);
  console.log(`  - Unique customers affected: ${customersMap.size}`);
  console.log(`  - Linked to a storefront account (shown in My account): ${linkedToAccount}`);
  console.log(`  - Without an email (no customer record): ${withoutEmail}\n`);

  if (!commit) {
    console.log(`🟡 DRY RUN COMPLETE. No data was written to the database.`);
    console.log(`To commit this import, re-run with: --commit\n`);
    await mongoose.disconnect();
    return;
  }

  // ─── COMMIT PHASE ─────────────────────────────────────────────────────────────
  console.log(`Inserting ${newOrdersCount} orders...`);
  let insertedCount = 0;
  const importedAt = new Date();

  for (const ord of parsedOrders) {
    if (alreadyThere(ord)) continue;

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
      user: (ord.email && userByEmail.get(ord.email)) || undefined,
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
      paymentMethod: mapPaymentMethod(ord.paymentMethod),
      paymentStatus: ord.paymentStatus,
      fulfilmentStatus: ord.fulfilmentStatus,
      status: ord.status,
      paidAt: ord.paidAt,
      shippedAt: ord.fulfilmentStatus === 'fulfilled' ? (ord.fulfilledAt || ord.createdAt) : undefined,
      refundedAmount: ord.refundedAmount,
      refundStatus: ord.paymentStatus === 'refunded' ? 'refunded' : ord.paymentStatus === 'partially_refunded' ? 'partially_refunded' : 'none',
      createdAt: ord.createdAt,
      updatedAt: ord.createdAt,
      tags: ord.tags,
      adminNotes: ord.notes,
      tagadaOrderId: ord.tagadaOrderId,
      source: 'shopify_import',
      // History only — every automatic step counts as already done (see header):
      suppressConfirmationEmail: true,
      inventoryDecrementedAt: ord.createdAt, // no stock change, no low-stock alert
      sideEffectsClaimedAt: importedAt,      // onOrderPaid never runs (admin email, customer totals, coupons, analytics)
      sideEffectsCompletedAt: importedAt,
      abandonedReminderSentAt: importedAt,   // no "complete your order" email
      shipmentEmailSentAt: importedAt,       // a late Starshipit webhook sends no shipping email
      addressValidation: { checkedAt: importedAt, validationMessage: 'Not checked (imported from Shopify)' }, // no Google lookup when opened
    });

    insertedCount++;
    if (insertedCount % 50 === 0 || insertedCount === newOrdersCount) {
      console.log(`  - Inserted ${insertedCount}/${newOrdersCount} orders...`);
    }
  }

  // Backfill missing line item images on orders imported earlier (e.g. by a previous version of this
  // script). Imported orders only — live orders are never touched here (the admin order view
  // resolves their missing images when opened). Only productImageUrl is set; failures are skipped.
  const importedMissingImages = await Order.find({
    $and: [
      { $or: [{ source: 'shopify_import' }, { tags: 'shopify-import' }] },
      { 'lineItems.0': { $exists: true } },
      { $or: [{ 'lineItems.productImageUrl': { $exists: false } }, { 'lineItems.productImageUrl': null }, { 'lineItems.productImageUrl': '' }] },
    ],
  }).select('lineItems').lean();

  if (importedMissingImages.length > 0) {
    console.log(`\nFound ${importedMissingImages.length} imported orders with line items missing images.`);
    let backfilled = 0;
    for (const ord of importedMissingImages) {
      const set: Record<string, string> = {};
      (ord.lineItems || []).forEach((li: any, i: number) => {
        if (li.productImageUrl) return;
        const img = (li.sku && skuToImage.get(String(li.sku).toLowerCase())) || nameToImage.get(String(li.title || '').toLowerCase());
        if (img) set[`lineItems.${i}.productImageUrl`] = img;
      });
      if (!Object.keys(set).length) continue;
      try {
        await Order.updateOne({ _id: ord._id }, { $set: set }, { timestamps: false });
        backfilled++;
      } catch (err: any) {
        console.warn(`  - Could not backfill images for order ${ord._id}: ${err?.message}`);
      }
    }
    console.log(`  - Backfilled images for ${backfilled} orders.`);
  }

  console.log(`\nUpdating customer records and history...`);
  let customersUpdated = 0;
  let customersCreated = 0;

  for (const [email, cData] of customersMap.entries()) {
    // Recount from ALL of this customer's orders (new site + imported, any email casing), with the
    // revenue definition used by the reports (domain/revenue.ts): paid / partially refunded /
    // refunded orders, net of refunds. Unpaid and cancelled orders are history only.
    const emailRe = new RegExp(`^${escapeRegex(email)}$`, 'i');
    const customerOrders = await Order.find({
      $or: [{ customerEmail: emailRe }, { 'customer.email': emailRe }],
      paymentStatus: { $in: REVENUE_PAYMENT_STATUSES },
      isDeleted: { $ne: true },
    }).select('grandTotal totalAmount refundedAmount').lean();

    const orderCount = customerOrders.length;
    const totalSpent = customerOrders.reduce((sum, o: any) => sum + ((o.grandTotal ?? o.totalAmount ?? 0) - (o.refundedAmount || 0)), 0);
    // Customer.defaultAddress has no company/phone
    const { company: _company, phone: _phone, ...address } = cData.address || {};
    const firstOrderAt = cData.orders.reduce((min, o) => (o.createdAt < min ? o.createdAt : min), cData.orders[0].createdAt);

    const existingCustomer = await Customer.findOne({ email });

    if (existingCustomer) {
      existingCustomer.orderCount = orderCount;
      existingCustomer.totalSpent = Math.round(totalSpent * 100) / 100;
      if (!existingCustomer.phone && cData.phone) existingCustomer.phone = cData.phone;
      if (!existingCustomer.defaultAddress?.street1 && address.street1) existingCustomer.defaultAddress = address;
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
        defaultAddress: address,
        country: address.country || 'AU',
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
        createdAt: firstOrderAt, // customer since their first Shopify order, not "new today" on the dashboard
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
  const skipVoided = args.includes('--skip-voided');
  const uriArg = args.find((a) => a.startsWith('--uri='))?.replace(/^--uri=/, '');
  const filePath = args.find((a) => !a.startsWith('--'));
  if (!filePath) {
    console.error('Usage: importShopifyOrders.ts "<orders_export.csv>" [--commit] [--skip-voided] [--uri=mongodb://...]');
    process.exit(1);
  }

  importShopifyOrders({ filePath, commit, mongoUri: uriArg, skipVoided })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Import failed with error:', err);
      process.exit(1);
    });
}
