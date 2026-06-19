import mongoose from 'mongoose';

export interface ICoaTestResult {
  name: string;
  result: string;
  unit?: string;
  pass?: boolean;
}

export interface ICOA extends mongoose.Document {
  product: mongoose.Types.ObjectId;
  batchReference: string;
  purity?: number;
  endotoxin?: string;
  sterility?: 'pass' | 'fail';
  netContent?: string;
  tests: ICoaTestResult[];
  analysisDate?: Date;
  labName: string;
  fileUrl: string;
  status: 'pending' | 'verified';
  showOnIndex: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const coaSchema = new mongoose.Schema<ICOA>(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'A COA must belong to a product'],
    },
    batchReference: {
      type: String,
      required: [true, 'A COA must have a batch reference'],
      trim: true,
    },
    purity: {
      type: Number,
      min: [0, 'Purity percentage must be positive'],
      max: [100, 'Purity percentage cannot exceed 100'],
    },
    endotoxin: {
      type: String,
      trim: true,
    },
    sterility: {
      type: String,
      enum: ['pass', 'fail'],
      default: 'pass',
    },
    netContent: {
      type: String,
      trim: true,
    },
    tests: [
      {
        name: { type: String, required: true },
        result: { type: String, required: true },
        unit: { type: String },
        pass: { type: Boolean, default: true },
      },
    ],
    analysisDate: {
      type: Date,
    },
    labName: {
      type: String,
      required: [true, 'A COA must specify the lab name'],
      trim: true,
    },
    fileUrl: {
      type: String,
      required: [true, 'A COA must have a file URL'],
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'verified'],
      default: 'pending',
    },
    showOnIndex: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

coaSchema.index({ product: 1 });
coaSchema.index({ batchReference: 1 });
coaSchema.index({ status: 1 });

export const COA = mongoose.model<ICOA>('COA', coaSchema);
export default COA;
