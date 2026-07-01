import mongoose, { Schema, Document } from 'mongoose';

export interface IBatch extends Document {
  batchId: string;
  displayName?: string;
  productId: mongoose.Types.ObjectId;
  variantSku?: string;
  variantId?: mongoose.Types.ObjectId; // Per-variant ObjectId reference

  purity?: string;
  measuredContent?: string;
  content?: string; // Alias for measuredContent (Shopify spec name)
  method?: string;

  coaUrl?: string;
  coaStatus: 'pending' | 'approved';

  // COA content flags
  includesPurity: boolean;
  includesMeasuredContent: boolean;
  includesEndotoxin: boolean;
  includesSterility: boolean;

  // Test flags
  hasEndotoxinTest: boolean;
  hasSterilityTest: boolean;
  endotoxinIncludedInCoa: boolean;  // NEW: distinct from hasEndotoxinTest
  sterilityIncludedInCoa: boolean;  // NEW: distinct from hasSterilityTest

  endotoxinReportUrl?: string;
  sterilityReportUrl?: string;

  appearance?: string;
  notes?: string;

  status: 'active' | 'inactive';

  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<IBatch>({
  batchId: { type: String, required: true },
  displayName: { type: String },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantSku: { type: String, required: false },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

  purity: { type: String },
  measuredContent: { type: String },
  content: { type: String },
  method: { type: String },

  coaUrl: { type: String },
  coaStatus: { type: String, enum: ['pending', 'approved'], default: 'pending' },

  includesPurity: { type: Boolean, default: true },
  includesMeasuredContent: { type: Boolean, default: true },
  includesEndotoxin: { type: Boolean, default: false },
  includesSterility: { type: Boolean, default: false },

  hasEndotoxinTest: { type: Boolean, default: false },
  hasSterilityTest: { type: Boolean, default: false },
  endotoxinIncludedInCoa: { type: Boolean, default: false },
  sterilityIncludedInCoa: { type: Boolean, default: false },

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
