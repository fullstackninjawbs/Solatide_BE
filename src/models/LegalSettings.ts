import mongoose, { Schema, Document } from 'mongoose';

const LegalSettingsSchema = new Schema({ shippingPolicyHtml: String, refundPolicyHtml: String, privacyPolicyHtml: String, termsHtml: String, researchUseDisclaimerHtml: String }, { timestamps: true });
export default mongoose.model('LegalSettings', LegalSettingsSchema);