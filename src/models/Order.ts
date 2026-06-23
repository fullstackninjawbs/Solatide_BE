import mongoose, { Schema, Document } from 'mongoose';

/**
 * Order.ts — lightweight Order stub for the admin panel's import/stub layer.
 * The canonical Order model with full schema lives in order.model.ts.
 * These fields mirror the payment-related fields added there.
 */
export interface IOrder extends Document {
  paymentStatus: 'pending' | 'paid' | 'failed' | 'refunded';
  fulfilmentStatus: 'unfulfilled' | 'processing' | 'dispatched' | 'delivered' | 'cancelled';
  paymentMethod?: 'tagada' | 'payid' | 'bank_transfer';
  paymentDeadline?: Date;
  trackingNumber?: string;
  courier?: string;
  trackingUrl?: string;
  // TagadaPay-specific
  tagadaPaymentId?: string;
  tagadaPaymentStatus?: 'initiated' | 'authorized' | 'captured' | 'failed' | 'refunded';
  currency: string;
  customerEmail?: string;
  customerName?: string;
}

const OrderSchema = new Schema(
  {
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    fulfilmentStatus: {
      type: String,
      enum: ['unfulfilled', 'processing', 'dispatched', 'delivered', 'cancelled'],
      default: 'unfulfilled',
    },
    paymentMethod: {
      type: String,
      enum: ['tagada', 'payid', 'bank_transfer'],
    },
    paymentDeadline: Date,
    trackingNumber: String,
    courier: String,
    trackingUrl: String,
    // TagadaPay
    tagadaPaymentId: String,
    tagadaPaymentStatus: {
      type: String,
      enum: ['initiated', 'authorized', 'captured', 'failed', 'refunded'],
    },
    currency: { type: String, default: 'AUD' },
    customerEmail: String,
    customerName: String,
  },
  { timestamps: true }
);

export default mongoose.model<IOrder>('Order', OrderSchema);