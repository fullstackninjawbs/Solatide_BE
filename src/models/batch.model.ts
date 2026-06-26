import mongoose, { Schema, Document } from 'mongoose';

export interface IBatch extends Document {
  batchId: string;
  displayName?: string;
  productId: mongoose.Types.ObjectId;
  variantSku?: string;
  
  purity?: string;
  measuredContent?: string;
  method?: string;
  
  coaUrl?: string;
  coaStatus: 'pending' | 'approved';
  
  includesPurity: boolean;
  includesMeasuredContent: boolean;
  includesEndotoxin: boolean;
  includesSterility: boolean;
  hasEndotoxinTest: boolean;
  hasSterilityTest: boolean;
  endotoxinReportUrl?: string;
  sterilityReportUrl?: string;
  
  appearance?: string;
  notes?: string;
  
  status: 'active' | 'inactive';
  
  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<IBatch>({
  batchId: { type: String, required: true },       // e.g. SOL-WLV-010
  displayName: { type: String },                   // optional
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantSku: { type: String, required: false },

  purity: { type: String },                        // e.g. "99.20%"
  measuredContent: { type: String },               // e.g. "BPC-157 15mg + TB-500 5mg"
  method: { type: String },                        // e.g. "HPLC + LC-MS Tested"

  coaUrl: { type: String },                        // link to COA PDF
  coaStatus: { type: String, enum: ['pending', 'approved'], default: 'pending' },

  includesPurity: { type: Boolean, default: true },
  includesMeasuredContent: { type: Boolean, default: true },
  includesEndotoxin: { type: Boolean, default: false },
  includesSterility: { type: Boolean, default: false },
  hasEndotoxinTest: { type: Boolean, default: false },
  hasSterilityTest: { type: Boolean, default: false },
  endotoxinReportUrl: { type: String },
  sterilityReportUrl: { type: String },

  appearance: { type: String },
  notes: { type: String },

  status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, {
  timestamps: true
});

const Batch = mongoose.model<IBatch>('Batch', batchSchema);

export default Batch;
