import mongoose, { Schema, Document } from 'mongoose';

export interface ICollection extends Document {
  title: string;
  slug: string;
  description?: string;
  image?: string;
  status: string;
  type: string;
  rules?: any[];
  sortOrder: number;
}

const CollectionSchema = new Schema({
  title: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  description: String,
  image: String,
  status: { type: String, enum: ['active', 'draft'], default: 'active' },
  type: { type: String, enum: ['manual', 'automated'], default: 'manual' },
  rules: [{ field: String, operator: String, value: String }],
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

export default mongoose.model<ICollection>('Collection', CollectionSchema);