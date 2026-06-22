import mongoose, { Schema, Document } from 'mongoose';

export interface ICustomer extends Document {
  name: string;
  email: string;
  country: string;
  orderCount: number;
  totalSpent: number;
  tags: string[];
  banned: boolean;
}

const CustomerSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  country: String,
  orderCount: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  tags: [String],
  banned: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model<ICustomer>('Customer', CustomerSchema);