import mongoose from 'mongoose';

export interface IBundleItem {
  product: mongoose.Types.ObjectId;
  quantity: number;
}

export interface IBundle extends mongoose.Document {
  name: string;
  sku: string;
  price: number;
  description?: string;
  includedProducts: IBundleItem[];
  decrementStockOfUnderlying: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const bundleSchema = new mongoose.Schema<IBundle>(
  {
    name: {
      type: String,
      required: [true, 'A bundle must have a name'],
      trim: true,
    },
    sku: {
      type: String,
      required: [true, 'A bundle must have a SKU'],
      unique: true,
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'A bundle must have a price'],
      min: [0, 'Price must be positive'],
    },
    description: {
      type: String,
    },
    includedProducts: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Product',
          required: [true, 'Bundle item must have a product reference'],
        },
        quantity: {
          type: Number,
          required: [true, 'Bundle item must have a quantity'],
          min: [1, 'Quantity must be at least 1'],
        },
      },
    ],
    decrementStockOfUnderlying: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

bundleSchema.index({ sku: 1 }, { unique: true });

export const Bundle = mongoose.model<IBundle>('Bundle', bundleSchema);
export default Bundle;
