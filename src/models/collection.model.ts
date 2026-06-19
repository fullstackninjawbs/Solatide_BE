import mongoose from 'mongoose';

export interface ICollection extends mongoose.Document {
  name: string;
  slug: string;
  description?: string;
  bannerImage?: string;
  sortOrder: number;
  displayOptions: {
    showFaqBlock: boolean;
  };
  products: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const collectionSchema = new mongoose.Schema<ICollection>(
  {
    name: {
      type: String,
      required: [true, 'A collection must have a name'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'A collection must have a slug'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: {
      type: String,
    },
    bannerImage: {
      type: String,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    displayOptions: {
      showFaqBlock: {
        type: Boolean,
        default: false,
      },
    },
    products: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
      },
    ],
  },
  {
    timestamps: true,
  }
);

collectionSchema.index({ slug: 1 }, { unique: true });

export const Collection = mongoose.model<ICollection>('Collection', collectionSchema);
export default Collection;
