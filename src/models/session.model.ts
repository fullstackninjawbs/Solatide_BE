import mongoose from 'mongoose';

export interface ISession extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  tokenHash: string;
  ipAddress?: string;
  userAgent?: string;
  lastSeen: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new mongoose.Schema<ISession>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A session must belong to a user'],
    },
    tokenHash: {
      type: String,
      required: [true, 'A session must have a token hash'],
      unique: true,
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
sessionSchema.index({ userId: 1 });
sessionSchema.index({ tokenHash: 1 });

export const Session = mongoose.model<ISession>('Session', sessionSchema);
export default Session;
