import mongoose, { Schema, Document } from 'mongoose';

export interface ICOA extends Document {
  productId: mongoose.Types.ObjectId;
  batchRef: string;
  purity: string;
  tests: any[];
  status: string;
  labName: string;
  pdfUrl: string;
}

const COASchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  batchRef: { type: String, required: true },
  purity: String,
  tests: [{ testName: String, result: String, unit: String, pass: Boolean }],
  status: { type: String, enum: ['pending', 'verified'], default: 'pending' },
  labName: String,
  pdfUrl: String
}, { timestamps: true });

export default mongoose.model<ICOA>('COA', COASchema);