import mongoose, { Schema, Document } from 'mongoose';

export interface IRefund extends Document {
  order: mongoose.Types.ObjectId;
  amount: number;
  reason: string;
  type: 'full' | 'partial';
  status: 'pending' | 'succeeded' | 'failed';
  tagadaRefundId?: string;
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
    },
    reason: {
      type: String,
      default: '',
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
    tagadaRefundId: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model<IRefund>('Refund', RefundSchema);
