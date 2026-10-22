import mongoose, { Schema, Document } from 'mongoose';

/**
 * PaymentSettings — stores gateway credentials and configuration.
 * Keys are stored in DB so the admin can update them from the UI
 * without redeploying the server.
 *
 * NOTE: In production, encrypt sensitive fields at rest.
 */
export interface IPaymentSettings extends Document {
  // Stripe (legacy)
  stripeKeys?: string;
  manualPaymentInstructions?: string;
  // TagadaPay
  tagadaEnv: 'sandbox' | 'production';
  tagadaApiKeySandbox: string;
  tagadaApiKeyProd: string;
  tagadaWebhookSecret: string;
  tagadaEnabled: boolean;
  /** Our own checkout with bank transfer / PayID (no card processor). See services/checkout/bankTransfer.ts */
  bankTransfer?: {
    enabled: boolean;
    accountName?: string;
    bankName?: string;
    bsb?: string;
    accountNumber?: string;
    payId?: string;
    swiftBic?: string;
    /** Shipping charged at checkout (AUD, GST incl.) */
    shippingFeeAU?: number;
    shippingFeeInternational?: number;
    /** Free Australian shipping at or above this subtotal (0/empty = never) */
    freeShippingThresholdAU?: number;
    internationalEnabled?: boolean;
    /** Unpaid orders are cancelled (stock released) after this many days, when the job runs */
    unpaidCancelDays?: number;
    notifyAdminOnOrder?: boolean;
  };
}

const PaymentSettingsSchema = new Schema<IPaymentSettings>(
  {
    // Stripe (kept for backward compat)
    stripeKeys: String,
    manualPaymentInstructions: String,
    // TagadaPay
    tagadaEnv: {
      type: String,
      enum: ['sandbox', 'production'],
      default: 'sandbox',
    },
    tagadaApiKeySandbox: { type: String, default: '' },
    tagadaApiKeyProd: { type: String, default: '' },
    tagadaWebhookSecret: { type: String, default: '' },
    tagadaEnabled: { type: Boolean, default: false },
    bankTransfer: {
      enabled: { type: Boolean, default: false },
      accountName: { type: String, trim: true, default: '' },
      bankName: { type: String, trim: true, default: '' },
      bsb: { type: String, trim: true, default: '' },
      accountNumber: { type: String, trim: true, default: '' },
      payId: { type: String, trim: true, default: '' },
      swiftBic: { type: String, trim: true, default: '' },
      shippingFeeAU: { type: Number, min: 0, default: 0 },
      shippingFeeInternational: { type: Number, min: 0, default: 0 },
      freeShippingThresholdAU: { type: Number, min: 0, default: 0 },
      internationalEnabled: { type: Boolean, default: true },
      unpaidCancelDays: { type: Number, min: 1, max: 60, default: 3 },
      notifyAdminOnOrder: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

export default mongoose.model<IPaymentSettings>('PaymentSettings', PaymentSettingsSchema);