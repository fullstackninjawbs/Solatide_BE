import mongoose, { Schema, Document } from 'mongoose';

const StoreSettingsSchema = new Schema({ storeName: String, contactEmail: String, baseCurrency: String, freeShippingThreshold: Number }, { timestamps: true });
export default mongoose.model('StoreSettings', StoreSettingsSchema);