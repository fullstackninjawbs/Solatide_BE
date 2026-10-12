import mongoose, { Schema, Document } from 'mongoose';

export interface IRefund extends Document {
  order: mongoose.Types.ObjectId;
  /** Major units (dollars) */
  amount: number;
  reason: string;
  type: 'full' | 'partial';
  status: 'pending' | 'succeeded' | 'failed';
  source?: 'admin' | 'provider_webhook';
  tagadaRefundId?: string | null;
  initiatedBy?: string;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RefundSchema: Schema = new Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [0.01, 'Refund amount must be greater than 0'],
    },
    reason: {
      type: String,
      default: '',
      maxlength: 500,
    },
    type: {
      type: String,
      enum: ['full', 'partial'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed'],
      default: 'pending',
    },
    source: {
      type: String,
      enum: ['admin', 'provider_webhook'],
      default: 'admin',
    },
    tagadaRefundId: {
      type: String,
      default: null,
    },
    initiatedBy: { type: String },
    failureReason: { type: String },
  },
  {
    timestamps: true,
  }
);

RefundSchema.index({ order: 1, createdAt: -1 });
RefundSchema.index({ order: 1, status: 1 });
// Unique among real provider ids only, so webhook redeliveries cannot create duplicates.
RefundSchema.index(
  { tagadaRefundId: 1 },
  { name: 'tagadaRefundId_unique_str', unique: true, partialFilterExpression: { tagadaRefundId: { $type: 'string' } } }
);

export default mongoose.model<IRefund>('Refund', RefundSchema);
