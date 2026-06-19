import mongoose from 'mongoose';

// Newsletter Subscriber Schema
export interface INewsletterSubscriber extends mongoose.Document {
  email: string;
  source: 'footer' | 'homepage' | 'checkout' | 'admin';
  status: 'active' | 'unsubscribed';
  subscribedAt: Date;
}

const newsletterSubscriberSchema = new mongoose.Schema<INewsletterSubscriber>(
  {
    email: {
      type: String,
      required: [true, 'Email is required for newsletter subscription'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email address',
      ],
    },
    source: {
      type: String,
      enum: ['footer', 'homepage', 'checkout', 'admin'],
      default: 'footer',
    },
    status: {
      type: String,
      enum: ['active', 'unsubscribed'],
      default: 'active',
    },
  },
  {
    timestamps: { createdAt: 'subscribedAt', updatedAt: true },
  }
);

// Restock Alert Schema
export interface IRestockAlert extends mongoose.Document {
  product: mongoose.Types.ObjectId;
  email: string;
  isNotified: boolean;
  notifiedAt?: Date;
  createdAt: Date;
}

const restockAlertSchema = new mongoose.Schema<IRestockAlert>(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Restock alert must belong to a product'],
    },
    email: {
      type: String,
      required: [true, 'Email is required for restock alerts'],
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email address',
      ],
    },
    isNotified: {
      type: Boolean,
      default: false,
    },
    notifiedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Affiliate Program Schemas
export interface IAffiliatePayout {
  amount: number;
  method: string;
  status: 'pending' | 'completed' | 'cancelled';
  paidAt?: Date;
  requestedAt?: Date;
}

export interface IAffiliate extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  referralCode: string;
  commissionRate: number;
  status: 'active' | 'suspended' | 'pending';
  balance: number;
  payoutHistory: IAffiliatePayout[];
  createdAt: Date;
  updatedAt: Date;
}

const affiliateSchema = new mongoose.Schema<IAffiliate>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An affiliate record must have a linked user account'],
      unique: true,
    },
    referralCode: {
      type: String,
      required: [true, 'A referral code is required'],
      unique: true,
      trim: true,
      uppercase: true,
    },
    commissionRate: {
      type: Number,
      default: 10,
      min: [0, 'Commission rate cannot be negative'],
      max: [100, 'Commission rate cannot exceed 100%'],
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'pending'],
      default: 'pending',
    },
    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },
    payoutHistory: [
      {
        amount: { type: Number, required: true },
        method: { type: String, required: true },
        status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending' },
        paidAt: { type: Date },
        requestedAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

newsletterSubscriberSchema.index({ email: 1 }, { unique: true });
restockAlertSchema.index({ product: 1, isNotified: 1 });
affiliateSchema.index({ referralCode: 1 }, { unique: true });

export const NewsletterSubscriber = mongoose.model<INewsletterSubscriber>('NewsletterSubscriber', newsletterSubscriberSchema);
export const RestockAlert = mongoose.model<IRestockAlert>('RestockAlert', restockAlertSchema);
export const Affiliate = mongoose.model<IAffiliate>('Affiliate', affiliateSchema);
