import mongoose from 'mongoose';

export interface ICollectionRule {
  field: string;
  operator: string;
  value: string;
}

export interface ICollection extends mongoose.Document {
  name: string;
  slug: string;
  description?: string;
  bannerImage?: string;
  status: 'active' | 'draft';
  type: 'manual' | 'automated';
  ruleRelation: 'all' | 'any';
  rules: ICollectionRule[];
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
    status: {
      type: String,
      enum: ['active', 'draft'],
      default: 'active',
    },
    type: {
      type: String,
      enum: ['manual', 'automated'],
      default: 'manual',
    },
    ruleRelation: {
      type: String,
      enum: ['all', 'any'],
      default: 'all',
    },
    rules: [
      {
        field: { type: String, required: true },
        operator: { type: String, required: true },
        value: { type: String, required: true },
      },
    ],
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
