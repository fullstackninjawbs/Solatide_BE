import mongoose, { Schema, Document } from 'mongoose';

const AffiliateSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  referralCode: { type: String, unique: true },
  commissionRate: Number,
  status: { type: String, enum: ['pending', 'active', 'suspended'], default: 'pending' },
  stats: { clicks: { type: Number, default: 0 }, conversions: { type: Number, default: 0 }, payouts: { type: Number, default: 0 } }
}, { timestamps: true });

export default mongoose.model('Affiliate', AffiliateSchema);