import mongoose from 'mongoose';

/**
 * Visitors, sessions and checkout attempts (see services/analytics/config.ts for the definitions).
 * Written by services/analytics/collect.ts (storefront events) and serverEvents.ts (orders).
 * Never contains IP addresses; contact details only when the customer typed them in checkout.
 */

const cartItemSchema = new mongoose.Schema(
  {
    productId: String,
    variantId: String,
    name: String,
    variantTitle: String,
    image: String,
    path: String,
    quantity: Number,
    unitPrice: Number,
  },
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    items: { type: [cartItemSchema], default: [] },
    itemCount: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    updatedAt: Date,
  },
  { _id: false }
);

const identitySchema = new mongoose.Schema(
  { email: String, name: String, customerId: String },
  { _id: false }
);

// ─── Visitor ────────────────────────────────────────────────────────────────

const visitorSchema = new mongoose.Schema(
  {
    visitorId: { type: String, required: true, unique: true },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    sessionCount: { type: Number, default: 0 },
    lastSessionId: String,
    identity: { type: identitySchema, default: undefined },
  },
  { timestamps: false }
);
visitorSchema.index({ 'identity.email': 1 }, { partialFilterExpression: { 'identity.email': { $type: 'string' } } });

// ─── Session ────────────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    visitorId: { type: String, required: true },
    startedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
    /** First session of this browser */
    isNewVisitor: Boolean,
    landingPage: String,
    referrer: String,
    source: {
      source: String,
      channel: String,
      referrerDomain: String,
      campaign: String,
      utm: { source: String, medium: String, campaign: String, content: String, term: String },
      clickId: String, // gclid | fbclid | ttclid | msclkid … (which one, not the value)
    },
    device: { type: { type: String }, label: String, os: String, browser: String },
    geo: { country: String, countryCode: String, region: String, city: String, method: String },
    counts: {
      pageViews: { type: Number, default: 0 },
      productViews: { type: Number, default: 0 },
      addToCart: { type: Number, default: 0 },
      removeFromCart: { type: Number, default: 0 },
      cartUpdates: { type: Number, default: 0 },
    },
    lastEvent: { type: { type: String }, path: String, productName: String, productImage: String, at: Date },
    cart: { type: cartSchema, default: undefined },
    checkout: { checkoutId: String, stage: String, startedAt: Date },
    identity: { type: identitySchema, default: undefined },
    orderIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
  },
  { timestamps: false }
);
sessionSchema.index({ lastActivityAt: -1 });
sessionSchema.index({ startedAt: -1 });
sessionSchema.index({ visitorId: 1, startedAt: -1 });

// ─── Checkout attempt ───────────────────────────────────────────────────────

/**
 * One checkout attempt: from opening checkout until an order is submitted. Abandoned = still
 * in_progress with no activity for CHECKOUT_ABANDON_MINUTES (derived when reporting). Payment
 * outcome (pending bank transfer / paid / cancelled / refunded) comes from the linked order.
 */
const checkoutSessionSchema = new mongoose.Schema(
  {
    checkoutId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    visitorId: { type: String, required: true },
    status: { type: String, enum: ['in_progress', 'order_submitted'], default: 'in_progress' },
    /** Furthest stage reached */
    stage: { type: String, enum: ['started', 'information', 'shipping', 'payment'], default: 'started' },
    stageAt: { information: Date, shipping: Date, payment: Date },
    startedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
    contact: { email: String, firstName: String, lastName: String, country: String },
    paymentMethod: String,
    cart: { type: cartSchema, default: undefined },
    errorCount: { type: Number, default: 0 },
    lastError: String,
    /** Came back after the abandon timeout */
    resumedCount: { type: Number, default: 0 },
    lastResumedAt: Date,
    orderId: mongoose.Schema.Types.ObjectId,
    orderSubmittedAt: Date,
  },
  { timestamps: false }
);
checkoutSessionSchema.index({ status: 1, lastActivityAt: -1 });
checkoutSessionSchema.index({ sessionId: 1 });

export const AnalyticsVisitor = mongoose.model('AnalyticsVisitor', visitorSchema);
export const AnalyticsSession = mongoose.model('AnalyticsSession', sessionSchema);
export const CheckoutSession = mongoose.model('CheckoutSession', checkoutSessionSchema);
