import mongoose, { Schema, Document } from 'mongoose';

const ReviewSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  rating: Number,
  comment: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true });

export default mongoose.model('Review', ReviewSchema);