import mongoose, { Schema, Document } from 'mongoose';

export interface ICustomerComment {
  text: string;
  createdAt: Date;
}

export interface IAddress {
  name?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface ICustomer extends Document {
  name: string;
  email: string;
  phone?: string;
  defaultAddress?: IAddress;
  country: string;
  orderCount: number;
  totalSpent: number;
  tags: string[];
  banned: boolean;
  comments: ICustomerComment[];
}

const CustomerSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: String,
  defaultAddress: {
    name: String,
    street1: String,
    street2: String,
    city: String,
    state: String,
    zip: String,
    country: String
  },
  country: String,
  orderCount: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  tags: [String],
  banned: { type: Boolean, default: false },
  comments: [{
    text: String,
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

export default mongoose.model<ICustomer>('Customer', CustomerSchema);