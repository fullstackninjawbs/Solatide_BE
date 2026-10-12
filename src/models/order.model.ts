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
  phone?: string;
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
  /** Selected variant (_id of product.variants[]) — resolved server-side (M-11) */
  variant?: mongoose.Types.ObjectId | null;
  tagadaVariantId?: string;
  sku?: string;
  title?: string;
  variantTitle?: string;
}

export interface ISideEffectError {
  step: string;
  message: string;
  at: Date;
}

export interface IOversell {
  product?: mongoose.Types.ObjectId;
  variant?: mongoose.Types.ObjectId | null;
  sku?: string;
  quantity: number;
  at: Date;
}

// ─── Attribution ───────────────────────────────────────────────────────────────

export interface IAttributionTouch {
  source?: string;
  channel?: string;
  sourceDomain?: string;
  referrerUrl?: string;
  landingPage?: string;

  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  utmId?: string;

  gclid?: string;
  fbclid?: string;
  ttclid?: string;
  msclkid?: string;

  sessionId?: string;
  capturedAt?: Date;
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
  couponCode?: string;
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
  paymentMethod?: 'tagada' | 'payid' | 'bank_transfer' | 'manual_offline';
  paymentStatus: 'pending' | 'paid' | 'failed' | 'cancelled' | 'partially_refunded' | 'refunded';
  source?: 'storefront' | 'admin_manual' | 'web';
  createdByAdmin?: {
    id: string;
    email: string;
    name?: string;
  };
  /** Tagada checkout-session id set at session creation (null, never 'unknown') */
  tagadaPaymentId?: string | null;
  /** Tagada Payment object id (pay_...) from payment/* webhooks — used for refunds */
  tagadaProviderPaymentId?: string | null;
  tagadaPaymentStatus?: string;
  tagadaEnv?: 'sandbox' | 'production';
  /** Reserved + confirmed refunds (major units). Guarded so it never exceeds grandTotal. */
  refundedAmount: number;
  /** Portion of refundedAmount still awaiting provider confirmation */
  pendingRefundAmount?: number;
  refundStatus: 'none' | 'initiated' | 'partially_refunded' | 'refunded';

  // ── Public (guest) access & post-payment bookkeeping ────────────────────────
  publicAccessToken?: string;
  paidAt?: Date | null;
  sideEffectsClaimedAt?: Date | null;
  sideEffectsCompletedAt?: Date | null;
  sideEffectErrors?: ISideEffectError[];
  inventoryDecrementedAt?: Date | null;
  oversold?: boolean;
  oversells?: IOversell[];
  discountDescription?: string;
  discountViolation?: { code: string; reason: string; at: Date } | null;
  suppressConfirmationEmail?: boolean;

  // ── Shipping Providers ────────────────────────────────────────────────────────
  trackingNumber?: string;
  trackingCarrier?: string;
  labelUrl?: string;
  trackingUrl?: string;
  shipmentStatus?: string;
  shippedAt?: Date;
  /** @deprecated EasyPost is being replaced by Starshipit */
  easyPostShipmentId?: string;
  starshipitOrderId?: string;

  // ── Metadata ─────────────────────────────────────────────────────────────────
  tags?: string[];
  adminNotes?: string;
  comments?: { text: string; createdAt: Date }[];
  isDeleted?: boolean;

  // ── Validation ───────────────────────────────────────────────────────────────
  addressValidation?: {
    isValid: boolean;
    needsReview: boolean;
    validationMessage?: string;
    suggestedAddress?: any;
    googleResponse?: any;
    checkedAt?: Date;
  };

  // ── Attribution ──────────────────────────────────────────────────────────────
  attribution?: {
    firstTouch?: IAttributionTouch;
    lastTouch?: IAttributionTouch;
  };

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
    phone: { type: String, trim: true },
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
        variant: { type: mongoose.Schema.Types.ObjectId, default: null },
        tagadaVariantId: { type: String },
        sku: { type: String },
        title: { type: String },
        variantTitle: { type: String },
      },
    ],

    // ── Totals ───────────────────────────────────────────────────────────────────
    subtotal: { type: Number },
    shippingAmount: { type: Number },
    taxAmount: { type: Number },
    discountAmount: { type: Number },
    couponCode: { type: String, trim: true },
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
      enum: ['tagada', 'payid', 'bank_transfer', 'manual_offline'],
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded'],
      default: 'pending',
    },
    source: {
      type: String,
      enum: ['storefront', 'admin_manual', 'web'],
      default: 'storefront',
    },
    createdByAdmin: {
      id: { type: String },
      email: { type: String },
      name: { type: String }
    },

    // ── TagadaPay ────────────────────────────────────────────────────────────────
    tagadaPaymentId: { type: String, default: null },
    tagadaProviderPaymentId: { type: String, default: null },
    tagadaPaymentStatus: {
      type: String,
      enum: ['initiated', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded', 'succeeded', 'pending', 'cancelled', 'unknown'],
    },
    tagadaEnv: {
      type: String,
      enum: ['sandbox', 'production'],
      default: 'sandbox'
    },
    refundedAmount: {
      type: Number,
      default: 0
    },
    pendingRefundAmount: { type: Number, default: 0, min: 0 },
    refundStatus: {
      type: String,
      enum: ['none', 'initiated', 'partially_refunded', 'refunded'],
      default: 'none'
    },

    // ── Public access & post-payment bookkeeping (H-4 / M-13) ─────────────────
    publicAccessToken: { type: String, select: false, index: true },
    paidAt: { type: Date, default: null },
    sideEffectsClaimedAt: { type: Date, default: null },
    sideEffectsCompletedAt: { type: Date, default: null },
    sideEffectErrors: {
      type: [{
        step: { type: String },
        message: { type: String },
        at: { type: Date },
      }],
      default: undefined,
    },
    inventoryDecrementedAt: { type: Date, default: null },
    oversold: { type: Boolean, default: false },
    oversells: {
      type: [{
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        variant: { type: mongoose.Schema.Types.ObjectId, default: null },
        sku: { type: String },
        quantity: { type: Number },
        at: { type: Date },
      }],
      default: undefined,
    },
    discountDescription: { type: String, trim: true },
    discountViolation: {
      code: { type: String },
      reason: { type: String },
      at: { type: Date },
    },
    suppressConfirmationEmail: { type: Boolean, default: false },

    // ── Shipping Providers ────────────────────────────────────────────────────────
    trackingNumber: { type: String },
    trackingCarrier: { type: String },
    labelUrl: { type: String },
    trackingUrl: { type: String },
    shipmentStatus: { type: String },
    shippedAt: { type: Date },
    easyPostShipmentId: { type: String },
    starshipitOrderId: { type: String },

    // ── Metadata ─────────────────────────────────────────────────────────────────
    tags: [{ type: String }],
    adminNotes: { type: String },
    comments: [{
      text: { type: String, required: true },
      createdAt: { type: Date, default: Date.now }
    }],
    isDeleted: { type: Boolean, default: false },

    // ── Validation ───────────────────────────────────────────────────────────────
    addressValidation: {
      isValid: { type: Boolean },
      needsReview: { type: Boolean },
      validationMessage: { type: String },
      suggestedAddress: { type: mongoose.Schema.Types.Mixed },
      googleResponse: { type: mongoose.Schema.Types.Mixed },
      checkedAt: { type: Date }
    },

    // ── Attribution ──────────────────────────────────────────────────────────────
    attribution: {
      firstTouch: {
        source: { type: String, trim: true },
        channel: { type: String, trim: true },
        sourceDomain: { type: String, trim: true },
        referrerUrl: { type: String, trim: true },
        landingPage: { type: String, trim: true },
        utmSource: { type: String, trim: true },
        utmMedium: { type: String, trim: true },
        utmCampaign: { type: String, trim: true },
        utmContent: { type: String, trim: true },
        utmTerm: { type: String, trim: true },
        utmId: { type: String, trim: true },
        gclid: { type: String, trim: true },
        fbclid: { type: String, trim: true },
        ttclid: { type: String, trim: true },
        msclkid: { type: String, trim: true },
        sessionId: { type: String, trim: true },
        capturedAt: { type: Date }
      },
      lastTouch: {
        source: { type: String, trim: true },
        channel: { type: String, trim: true },
        sourceDomain: { type: String, trim: true },
        referrerUrl: { type: String, trim: true },
        landingPage: { type: String, trim: true },
        utmSource: { type: String, trim: true },
        utmMedium: { type: String, trim: true },
        utmCampaign: { type: String, trim: true },
        utmContent: { type: String, trim: true },
        utmTerm: { type: String, trim: true },
        utmId: { type: String, trim: true },
        gclid: { type: String, trim: true },
        fbclid: { type: String, trim: true },
        ttclid: { type: String, trim: true },
        msclkid: { type: String, trim: true },
        sessionId: { type: String, trim: true },
        capturedAt: { type: Date }
      }
    }
  },
  { timestamps: true }
);

// Indexes for fast admin queries
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ fulfilmentStatus: 1 });
orderSchema.index({ status: 1 });
// tagadaPaymentId is unique only among real string values (null / missing allowed many times).
// Coexists with the old non-unique `tagadaPaymentId_1` index (nothing is dropped). Placeholder
// 'unknown' values must be set to null first — see src/scripts/migrations/2026-10-payment-indexes.ts.
orderSchema.index(
  { tagadaPaymentId: 1 },
  { name: 'tagadaPaymentId_unique_str', unique: true, partialFilterExpression: { tagadaPaymentId: { $type: 'string' } } }
);
orderSchema.index({ tagadaProviderPaymentId: 1 }, { sparse: true });
orderSchema.index({ tagadaOrderId: 1 }, { sparse: true });
orderSchema.index({ tagadaSessionId: 1 }, { sparse: true });
orderSchema.index({ customerEmail: 1 });
orderSchema.index({ user: 1 });
orderSchema.index({ couponCode: 1, customerEmail: 1 }, { sparse: true });
orderSchema.index({ 'customer.email': 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'attribution.firstTouch.source': 1 });
orderSchema.index({ 'attribution.firstTouch.channel': 1 });
orderSchema.index({ 'attribution.firstTouch.utmCampaign': 1 });
// Compound indexes for common admin filter + sort combinations
orderSchema.index({ paymentStatus: 1, createdAt: -1 });
orderSchema.index({ fulfilmentStatus: 1, createdAt: -1 });
orderSchema.index({ 'customer.email': 1, createdAt: -1 });
orderSchema.index({ source: 1, createdAt: -1 });
export const Order = mongoose.model<IOrder>('Order', orderSchema);
export default Order;
