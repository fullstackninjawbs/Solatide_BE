import mongoose, { Schema, Document } from 'mongoose';

const PaymentSettingsSchema = new Schema({ stripeKeys: String, manualPaymentInstructions: String }, { timestamps: true });
export default mongoose.model('PaymentSettings', PaymentSettingsSchema);