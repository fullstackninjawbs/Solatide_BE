import mongoose from 'mongoose';

export interface IAuditLog extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  action: string;
  entityType: string;
  entityId: mongoose.Types.ObjectId;
  beforeSnapshot?: any;
  afterSnapshot?: any;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const auditLogSchema = new mongoose.Schema<IAuditLog>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An audit log must belong to a user'],
    },
    action: {
      type: String,
      required: [true, 'An audit log must have an action'],
      trim: true,
    },
    entityType: {
      type: String,
      required: [true, 'An audit log must have an entity type'],
      trim: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'An audit log must refer to an entity ID'],
    },
    beforeSnapshot: {
      type: mongoose.Schema.Types.Mixed,
    },
    afterSnapshot: {
      type: mongoose.Schema.Types.Mixed,
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes for faster log scanning
auditLogSchema.index({ userId: 1 });
auditLogSchema.index({ action: 1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
export default AuditLog;
