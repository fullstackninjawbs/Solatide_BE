import mongoose, { Schema, Document } from 'mongoose';

export interface IDiscount extends Document {
  code: string;
  type: string;
  value: number;
  appliesTo: string;
  minPurchase: number;
  maxUses: number;
  usesSoFar: number;
  perCustomerLimit: number;
  activeFrom?: Date;
  activeTo?: Date;
  status: string;
}

const DiscountSchema = new Schema({
  code: { type: String, required: true, unique: true },
  type: { type: String, enum: ['percent', 'fixed'] },
  value: { type: Number, required: true },
  appliesTo: { type: String, enum: ['all', 'products', 'collections'], default: 'all' },
  minPurchase: { type: Number, default: 0 },
  maxUses: { type: Number, default: 0 },
  usesSoFar: { type: Number, default: 0 },
  perCustomerLimit: { type: Number, default: 1 },
  activeFrom: Date,
  activeTo: Date,
  status: { type: String, enum: ['active', 'expired', 'disabled'], default: 'active' }
}, { timestamps: true });

export default mongoose.model<IDiscount>('Discount', DiscountSchema);