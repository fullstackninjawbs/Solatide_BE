import mongoose, { Schema, Document } from 'mongoose';

const StoreSettingsSchema = new Schema({ 
  storeName: String, 
  contactEmail: String, 
  contactPhone: String,
  baseCurrency: String, 
  freeShippingThreshold: Number,
  shippingOrigin: {
    name: String,
    company: String,
    street1: String,
    street2: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    phone: String
  }
}, { timestamps: true });
export default mongoose.model('StoreSettings', StoreSettingsSchema);