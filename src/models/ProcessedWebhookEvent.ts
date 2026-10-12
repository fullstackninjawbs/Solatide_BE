import mongoose, { Schema, Document } from 'mongoose';

/**
 * ProcessedWebhookEvent — replay protection for inbound webhooks (H-5).
 * A delivery is "claimed" by inserting {provider, eventId}; the unique index
 * makes a concurrent or later duplicate fail with E11000 and be ACKed as a
 * duplicate without processing. Records are kept permanently (never deleted).
 */
export interface IProcessedWebhookEvent extends Document {
  provider: string;
  eventId: string;
  eventIdSource?: string;
  eventType?: string;
  order?: mongoose.Types.ObjectId | null;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}


const ProcessedWebhookEventSchema = new Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    eventIdSource: { type: String },
    eventType: { type: String },
    order: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    status: { type: String, enum: ['received', 'processed', 'ignored', 'failed'], default: 'received' },
    error: { type: String },
  },
  { timestamps: true }
);

ProcessedWebhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
// No TTL: records are kept permanently (no automatic deletion of any data).
ProcessedWebhookEventSchema.index({ createdAt: 1 });

export const ProcessedWebhookEvent = mongoose.model<IProcessedWebhookEvent>(
  'ProcessedWebhookEvent',
  ProcessedWebhookEventSchema
);
export default ProcessedWebhookEvent;
