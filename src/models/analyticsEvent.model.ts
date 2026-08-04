import mongoose from 'mongoose';

export type AnalyticsEventType =
  | 'page_view'
  | 'product_view'
  | 'add_to_cart'
  | 'begin_checkout'
  | 'purchase';

export interface IAnalyticsEvent extends mongoose.Document {
  sessionId: string;
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
  path?: string;
}

const analyticsEventSchema = new mongoose.Schema<IAnalyticsEvent>(
  {
    sessionId: {
      type: String,
      required: [true, 'sessionId is required'],
      index: true,
    },
    eventType: {
      type: String,
      required: [true, 'eventType is required'],
      enum: ['page_view', 'product_view', 'add_to_cart', 'begin_checkout', 'purchase'],
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
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
    path: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: false,
  }
);

analyticsEventSchema.index({ timestamp: -1, eventType: 1 });
analyticsEventSchema.index({ sessionId: 1, eventType: 1, timestamp: 1 });

export const AnalyticsEvent = mongoose.model<IAnalyticsEvent>('AnalyticsEvent', analyticsEventSchema);
export default AnalyticsEvent;
