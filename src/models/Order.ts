import mongoose, { Schema, Document } from 'mongoose';

export interface IOrder extends Document {
  // Using basic stub, assuming it expands on an existing model
  paymentStatus: string;
  fulfilmentStatus: string;
  paymentMethod: string;
  paymentDeadline?: Date;
  trackingNumber?: string;
  courier?: string;
  trackingUrl?: string;
}

const OrderSchema = new Schema({
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  fulfilmentStatus: { type: String, enum: ['unfulfilled', 'processing', 'dispatched', 'delivered', 'cancelled'], default: 'unfulfilled' },
  paymentMethod: { type: String, enum: ['card', 'payid', 'bank_transfer'] },
  paymentDeadline: Date,
  trackingNumber: String,
  courier: String,
  trackingUrl: String
}, { timestamps: true });

export default mongoose.model<IOrder>('Order', OrderSchema);