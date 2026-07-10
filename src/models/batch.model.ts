import mongoose, { Schema, Document } from 'mongoose';

export interface IBatch extends Document {
  batchId: string;
  vendorLotNumber?: string;
  displayName?: string;
  productId: mongoose.Types.ObjectId;
  variantSku?: string;
  variantId?: mongoose.Types.ObjectId; // Per-variant ObjectId reference

  purity?: string;
  measuredContent?: string;
  content?: string; // Alias for measuredContent (Shopify spec name)
  method?: string;

  /** @deprecated Use coaFile instead */
  coaUrl?: string;
  coaFile?: {
    url: string;
    filename: string;
    uploadedAt: Date;
  };
  coaStatus: 'pending' | 'approved';

  verificationDetails?: {
    labName?: string;
    coaReportId?: string;
    testDate?: Date;
    verificationUrl?: string;
  };

  qcLevel: 'full' | 'partial' | 'none';

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

  tests?: {
    purityHplc?: { performed: boolean; result?: string };
    netPeptideContent?: { performed: boolean; result?: string };
    identityHplc?: { performed: boolean; result?: string };
    fentanylScreen?: { performed: boolean; result?: string };
    hplcConformity?: { performed: boolean; result?: string };
    heavyMetalsIcpMs?: { performed: boolean; result?: string };
    sterilityPcr?: { performed: boolean; result?: string };
    endotoxinUsp85?: { performed: boolean; result?: string };
  };

  customTests?: Array<{ name: string; result: string }>;

  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<IBatch>({
  batchId: { type: String, required: true },
  vendorLotNumber: { type: String, trim: true },
  displayName: { type: String },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantSku: { type: String, required: false },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

  purity: { type: String },
  measuredContent: { type: String },
  content: { type: String },
  method: { type: String },

  coaUrl: { type: String },
  coaFile: {
    url: { type: String },
    filename: { type: String },
    uploadedAt: { type: Date }
  },
  coaStatus: { type: String, enum: ['pending', 'approved'], default: 'pending' },

  verificationDetails: {
    labName: { type: String, trim: true },
    coaReportId: { type: String, trim: true },
    testDate: { type: Date },
    verificationUrl: { type: String, trim: true }
  },

  qcLevel: { type: String, enum: ['full', 'partial', 'none'], default: 'none' },

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

  status: { type: String, enum: ['active', 'inactive'], default: 'active' },

  tests: {
    purityHplc: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    },
    netPeptideContent: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    },
    identityHplc: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    },
    fentanylScreen: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    },
    hplcConformity: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    },
    heavyMetalsIcpMs: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    },
    sterilityPcr: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    },
    endotoxinUsp85: {
      performed: { type: Boolean, default: false },
      result: { type: String, default: '' }
    }
  },
  customTests: [
    {
      name: { type: String, required: true },
      result: { type: String, default: '' }
    }
  ]
}, {
  timestamps: true
});

const Batch = mongoose.model<IBatch>('Batch', batchSchema);

export default Batch;
