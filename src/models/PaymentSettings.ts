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
  tagadaEnv: 'sandbox' | 'prod';
  tagadaApiKeySandbox: string;
  tagadaApiKeyProd: string;
  tagadaWebhookSecret: string;
  tagadaEnabled: boolean;
}

const PaymentSettingsSchema = new Schema<IPaymentSettings>(
  {
    // Stripe (kept for backward compat)
    stripeKeys: String,
    manualPaymentInstructions: String,
    // TagadaPay
    tagadaEnv: {
      type: String,
      enum: ['sandbox', 'prod'],
      default: 'sandbox',
    },
    tagadaApiKeySandbox: { type: String, default: '' },
    tagadaApiKeyProd: { type: String, default: '' },
    tagadaWebhookSecret: { type: String, default: '' },
    tagadaEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model<IPaymentSettings>('PaymentSettings', PaymentSettingsSchema);