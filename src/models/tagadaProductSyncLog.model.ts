import mongoose, { Document, Schema } from 'mongoose';

export interface ITagadaSyncChange {
  tagadaProductId: string;
  localProductId?: mongoose.Types.ObjectId;
  productName: string;
  action: 'created' | 'updated' | 'skipped' | 'failed';
  changedFields?: string[];
  error?: string;
}

export interface ITagadaProductSyncLog extends Document {
  initiatedBy?: mongoose.Types.ObjectId;
  syncType: 'preview' | 'full' | 'single' | 'scheduled';
  startedAt: Date;
  completedAt?: Date;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  totalFetched: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  changes: ITagadaSyncChange[];
  error?: string;
}

const syncChangeSchema = new Schema<ITagadaSyncChange>({
  tagadaProductId: { type: String, required: true },
  localProductId: { type: Schema.Types.ObjectId, ref: 'Product' },
  productName: { type: String, required: true },
  action: { type: String, enum: ['created', 'updated', 'skipped', 'failed'], required: true },
  changedFields: [{ type: String }],
  error: { type: String },
});

const tagadaProductSyncLogSchema = new Schema<ITagadaProductSyncLog>(
  {
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    syncType: { type: String, enum: ['preview', 'full', 'single', 'scheduled'], required: true },
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date },
    status: { type: String, enum: ['running', 'completed', 'completed_with_errors', 'failed'], required: true },
    totalFetched: { type: Number, default: 0 },
    createdCount: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    changes: [syncChangeSchema],
    error: { type: String },
  },
  {
    timestamps: true,
  }
);

const TagadaProductSyncLog = mongoose.model<ITagadaProductSyncLog>('TagadaProductSyncLog', tagadaProductSyncLogSchema);

export default TagadaProductSyncLog;
