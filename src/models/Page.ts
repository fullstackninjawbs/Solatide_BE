import mongoose, { Schema, Document } from 'mongoose';

const PageSchema = new Schema({
  title: String,
  slug: { type: String, unique: true },
  contentHtml: String,
  seo: { title: String, description: String },
  status: { type: String, enum: ['draft', 'published'], default: 'draft' }
}, { timestamps: true });

export default mongoose.model('Page', PageSchema);