import mongoose from 'mongoose';

// ─── Sub-types ─────────────────────────────────────────────────────────────────

export interface IAddressObj {
  name?: string;
  company?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface ICustomerSnapshot {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

export interface ILineItem {
  title: string;
  variantTitle?: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  productImageUrl?: string;
}

// ─── Legacy item (kept for backward-compat with pre-webhook orders) ─────────────

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  quantity: number;
  price: number;
}

// ─── Main Order interface ──────────────────────────────────────────────────────

export interface IOrder extends mongoose.Document {
  // ── Identifiers ──────────────────────────────────────────────────────────────
  orderNumber?: string;             // SOL-00042
  tagadaOrderId?: string;
  tagadaSessionId?: string;

  // ── Customer ─────────────────────────────────────────────────────────────────
  customer?: ICustomerSnapshot;
  /** @deprecated use customer.email */
  customerEmail?: string;
  /** @deprecated use customer.firstName + customer.lastName */
  customerName?: string;
  /** @deprecated use user ref */
  user?: mongoose.Types.ObjectId;

  // ── Addresses ─────────────────────────────────────────────────────────────────
  shippingAddressObj?: IAddressObj;
  billingAddressObj?: IAddressObj;
  /** @deprecated use shippingAddressObj */
  shippingAddress?: string;

  // ── Line Items ───────────────────────────────────────────────────────────────
  lineItems?: ILineItem[];
  /** @deprecated use lineItems */
  products?: IOrderItem[];

  // ── Totals ───────────────────────────────────────────────────────────────────
  subtotal?: number;
  shippingAmount?: number;
  taxAmount?: number;
  discountAmount?: number;
  grandTotal?: number;
  /** @deprecated use grandTotal */
  totalAmount?: number;
  currency: string;

  // ── Shipping / Delivery ───────────────────────────────────────────────────────
  shippingMethodName?: string;
  shippingMethodCode?: string;
  deliveryStatus?: 'pending' | 'tracking_added' | 'in_transit' | 'delivered';

  // ── Status ───────────────────────────────────────────────────────────────────
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  fulfilmentStatus: 'unfulfilled' | 'fulfilled' | 'partial';
  paymentMethod?: 'tagada' | 'payid' | 'bank_transfer';
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded';

  // ── TagadaPay ────────────────────────────────────────────────────────────────
  tagadaPaymentId?: string;
  tagadaPaymentStatus?: 'initiated' | 'authorized' | 'captured' | 'failed' | 'refunded';

  // ── EasyPost (stub — Phase 2) ─────────────────────────────────────────────────
  trackingNumber?: string;
  trackingCarrier?: string;
  labelUrl?: string;
  easyPostShipmentId?: string;

  // ── Metadata ─────────────────────────────────────────────────────────────────
  tags?: string[];
  adminNotes?: string;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Address sub-schema ────────────────────────────────────────────────────────

const addressSchema = new mongoose.Schema<IAddressObj>(
  {
    name: { type: String, trim: true },
    company: { type: String, trim: true },
    street1: { type: String, trim: true },
    street2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zip: { type: String, trim: true },
    country: { type: String, trim: true },
  },
  { _id: false }
);

// ─── Line Item sub-schema ──────────────────────────────────────────────────────

const lineItemSchema = new mongoose.Schema<ILineItem>(
  {
    title: { type: String, required: true },
    variantTitle: { type: String },
    sku: { type: String },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true },
    subtotal: { type: Number, required: true },
    productImageUrl: { type: String },
  },
  { _id: false }
);

// ─── Main schema ───────────────────────────────────────────────────────────────

const orderSchema = new mongoose.Schema<IOrder>(
  {
    // ── Identifiers ─────────────────────────────────────────────────────────────
    orderNumber: { type: String, unique: true, sparse: true },
    tagadaOrderId: { type: String },
    tagadaSessionId: { type: String },

    // ── Customer ─────────────────────────────────────────────────────────────────
    customer: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      email: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    customerEmail: { type: String, trim: true },
    customerName: { type: String, trim: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },

    // ── Addresses ─────────────────────────────────────────────────────────────────
    shippingAddressObj: { type: addressSchema },
    billingAddressObj: { type: addressSchema },
    shippingAddress: { type: String, trim: true },

    // ── Line Items ───────────────────────────────────────────────────────────────
    lineItems: { type: [lineItemSchema], default: undefined },
    products: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        quantity: { type: Number, min: 1 },
        price: { type: Number },
      },
    ],

    // ── Totals ───────────────────────────────────────────────────────────────────
    subtotal: { type: Number },
    shippingAmount: { type: Number },
    taxAmount: { type: Number },
    discountAmount: { type: Number },
    grandTotal: { type: Number },
    totalAmount: { type: Number, min: 0 },
    currency: { type: String, default: 'AUD' },

    // ── Shipping ─────────────────────────────────────────────────────────────────
    shippingMethodName: { type: String },
    shippingMethodCode: { type: String },
    deliveryStatus: {
      type: String,
      enum: ['pending', 'tracking_added', 'in_transit', 'delivered'],
    },

    // ── Status ───────────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'pending',
    },
    fulfilmentStatus: {
      type: String,
      enum: ['unfulfilled', 'fulfilled', 'partial'],
      default: 'unfulfilled',
    },
    paymentMethod: {
      type: String,
      enum: ['tagada', 'payid', 'bank_transfer'],
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },

    // ── TagadaPay ────────────────────────────────────────────────────────────────
    tagadaPaymentId: { type: String },
    tagadaPaymentStatus: {
      type: String,
      enum: ['initiated', 'authorized', 'captured', 'failed', 'refunded'],
    },

    // ── EasyPost (Phase 2 stubs) ──────────────────────────────────────────────────
    trackingNumber: { type: String },
    trackingCarrier: { type: String },
    labelUrl: { type: String },
    easyPostShipmentId: { type: String },

    // ── Metadata ─────────────────────────────────────────────────────────────────
    tags: [{ type: String }],
    adminNotes: { type: String },
  },
  { timestamps: true }
);

// Indexes for fast admin queries
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ fulfilmentStatus: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ tagadaPaymentId: 1 });
orderSchema.index({ 'customer.email': 1 });
orderSchema.index({ createdAt: -1 });

export const Order = mongoose.model<IOrder>('Order', orderSchema);
export default Order;
