import mongoose from 'mongoose';

/**
 * Storefront events (browser) and order events (server).
 * - 'purchase' = payment confirmed (server, clientReported:false); old browser 'purchase' events
 *   (clientReported:true) were sent when an order was submitted.
 * - 'order_placed' / 'order_cancelled' / 'order_refunded' are recorded by the server only.
 */
export const BROWSER_EVENT_TYPES = [
  'page_view', 'product_view', 'variant_select', 'add_to_cart', 'remove_from_cart', 'cart_quantity_change',
  'begin_checkout', 'checkout_step', 'checkout_error',
] as const;
export const SERVER_EVENT_TYPES = ['order_placed', 'purchase', 'order_cancelled', 'order_refunded'] as const;
export const ANALYTICS_EVENT_TYPES = [...BROWSER_EVENT_TYPES, ...SERVER_EVENT_TYPES] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];
export type CheckoutStage = 'information' | 'shipping' | 'payment';

export interface IAnalyticsEvent extends mongoose.Document {
  sessionId: string;
  /** Persistent anonymous browser ID (absent on events recorded before the visitor/session split) */
  visitorId?: string;
  /** Client-generated unique ID: the same event sent twice is stored once */
  eventId?: string;
  checkoutId?: string;
  eventType: AnalyticsEventType;
  timestamp: Date;
  country?: string;
  region?: string;
  city?: string;
  productId?: mongoose.Types.ObjectId;
  orderId?: mongoose.Types.ObjectId;
  cartValue?: number;
  page?: string;
  productName?: string;
  productImage?: string;
  variantId?: string;
  variantTitle?: string;
  quantity?: number;
  /** checkout_step: the stage reached; checkout_error: the stage it happened in */
  stage?: CheckoutStage;
  /** checkout_error: short reason (field names / server message), never what the customer typed */
  errorMessage?: string;
  path?: string;
  /** true for events sent by the browser (spoofable); excluded from purchase/revenue metrics */
  clientReported?: boolean;
}


const analyticsEventSchema = new mongoose.Schema<IAnalyticsEvent>(
  {
    sessionId: {
      type: String,
      required: [true, 'sessionId is required'],
      index: true,
    },
    visitorId: { type: String, trim: true },
    eventId: { type: String, trim: true },
    checkoutId: { type: String, trim: true },
    eventType: {
      type: String,
      required: [true, 'eventType is required'],
      enum: ANALYTICS_EVENT_TYPES,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    clientReported: {
      type: Boolean,
      default: false,
    },
    country: {
      type: String,
      trim: true,
    },
    region: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      trim: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
    },
    cartValue: {
      type: Number,
    },
    page: {
      type: String,
      trim: true,
    },
    productName: {
      type: String,
      trim: true,
    },
    productImage: { type: String, trim: true },
    variantId: { type: String, trim: true },
    variantTitle: { type: String, trim: true },
    quantity: { type: Number },
    stage: { type: String, enum: ['information', 'shipping', 'payment'] },
    errorMessage: { type: String, trim: true },
    path: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: false,
  }
);

// No TTL: analytics events are kept permanently (no automatic deletion of any data).
analyticsEventSchema.index({ timestamp: -1, eventType: 1 });
analyticsEventSchema.index({ eventType: 1, clientReported: 1, timestamp: -1 });
analyticsEventSchema.index({ sessionId: 1, eventType: 1, timestamp: 1 });
// Duplicate guard: a re-sent event (retry, re-render) has the same eventId. Partial, so events
// recorded before eventIds existed do not collide.
analyticsEventSchema.index({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });
analyticsEventSchema.index({ visitorId: 1, timestamp: -1 });
analyticsEventSchema.index({ checkoutId: 1, timestamp: 1 }, { partialFilterExpression: { checkoutId: { $type: 'string' } } });

export const AnalyticsEvent = mongoose.model<IAnalyticsEvent>('AnalyticsEvent', analyticsEventSchema);
export default AnalyticsEvent;
