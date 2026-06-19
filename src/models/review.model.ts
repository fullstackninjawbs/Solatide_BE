import mongoose from 'mongoose';

export interface IReview extends mongoose.Document {
  product: mongoose.Types.ObjectId;
  rating: number;
  title?: string;
  displayName: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
  isVerifiedPurchase: boolean;
  adminResponse?: string;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new mongoose.Schema<IReview>(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'A review must belong to a product'],
    },
    rating: {
      type: Number,
      required: [true, 'A review must have a rating'],
      min: [1, 'Rating must be at least 1.0'],
      max: [5, 'Rating cannot exceed 5.0'],
    },
    title: {
      type: String,
      trim: true,
    },
    displayName: {
      type: String,
      required: [true, 'A review must have a display name'],
      trim: true,
    },
    content: {
      type: String,
      required: [true, 'A review must have content text'],
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    isVerifiedPurchase: {
      type: Boolean,
      default: false,
    },
    adminResponse: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

reviewSchema.index({ product: 1, status: 1 });
reviewSchema.index({ rating: 1 });
reviewSchema.index({ createdAt: -1 });

export const Review = mongoose.model<IReview>('Review', reviewSchema);
export default Review;
