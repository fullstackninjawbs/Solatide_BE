import mongoose, { Schema, Document } from 'mongoose';

export interface IPage extends Document {
  title: string;
  slug: string;
  content: {
    html: string;
    json?: any; // To store structured content if the editor supports it
  };
  seoTitle?: string;
  metaDescription?: string;
  status: 'draft' | 'published';
  slugHistory: string[];
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PageSchema = new Schema<IPage>(
  {
    title: {
      type: String,
      required: true,
      maxlength: 120,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
    },
    content: {
      html: {
        type: String,
        default: '',
      },
      json: {
        type: Schema.Types.Mixed,
      },
    },
    seoTitle: {
      type: String,
    },
    metaDescription: {
      type: String,
    },
    status: {
      type: String,
      enum: ['draft', 'published'],
      default: 'draft',
    },
    slugHistory: {
      type: [String],
      default: [],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'AdminUser',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'AdminUser',
    },
    publishedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Ensure the slug is properly indexed
PageSchema.index({ slug: 1 });

export default mongoose.model<IPage>('Page', PageSchema);