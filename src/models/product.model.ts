import mongoose from 'mongoose';

export interface IProduct extends mongoose.Document {
  name: string;
  description: string;
  price: number;
  rating: number;
  inStock: boolean;
  category: string;
  status: 'In Stock' | 'Sold Out' | 'Sale';
  imageUrl?: string;
  createdAt: Date;
}

const productSchema = new mongoose.Schema<IProduct>(
  {
    name: {
      type: String,
      required: [true, 'A product must have a name'],
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      required: [true, 'A product must have a description'],
      default: 'Premium high-quality research compound for laboratory and scientific evaluation.',
    },
    price: {
      type: Number,
      required: [true, 'A product must have a price'],
      min: [0, 'Price must be positive'],
    },
    rating: {
      type: Number,
      default: 5.0,
      min: [1, 'Rating must be at least 1.0'],
      max: [5, 'Rating cannot exceed 5.0'],
    },
    inStock: {
      type: Boolean,
      default: true,
    },
    category: {
      type: String,
      required: [true, 'A product must have a category'],
      trim: true,
    },
    status: {
      type: String,
      enum: ['In Stock', 'Sold Out', 'Sale'],
      default: 'In Stock',
    },
    imageUrl: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for faster category and status searches
productSchema.index({ category: 1 });
productSchema.index({ price: 1 });

export const Product = mongoose.model<IProduct>('Product', productSchema);
export default Product;
