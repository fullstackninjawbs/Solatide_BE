import mongoose from 'mongoose';

export interface IProductImage {
  url: string;
  alt?: string;
  position?: number;
}

export interface IProductSeo {
  title?: string;
  description?: string;
  canonicalUrl?: string;
}

export interface IProductVariant {
  title: string;
  sku: string;
  price: number;
  compareAtPrice?: number | null;
  stockQty: number;
  inventoryPolicy: 'deny' | 'continue';
  requiresShipping: boolean;
  taxable: boolean;
  weightGrams?: number;
  tagadaVariantId?: string;
  currentBatchId?: mongoose.Types.ObjectId; // Per-variant batch reference
}

export interface IProduct extends mongoose.Document {
  id: number; // numeric id for backward compatibility
  name: string;
  slug: string; // auto-generated from name
  description: string;
  price: number;
  rating: number;
  inStock: boolean;
  category: string;
  researchCategory?: 'metabolic-pathway' | 'tissue-cellular' | 'dermal-pigmentation' | 'laboratory-support';
  /** @deprecated Use status field instead */
  status: 'In Stock' | 'Sold Out' | 'Sale';
  /** Shopify-equivalent status */
  publishStatus: 'active' | 'draft' | 'archived';
  /** @deprecated Use tags[] instead */
  tag?: string;
  tags: string[]; // Array of tags
  reviewsCount?: number;
  imageUrl?: string;
  sku?: string;
  tagadaVariantId?: string;
  compareAtPrice?: number;
  stockQuantity: number;
  lowStockThreshold: number;
  molecularFormula?: string;
  molecularWeight?: string;
  casNumber?: string;
  appearance?: string;
  purity?: string;
  researchApplications: string[];
  batchReference?: string;
  coaRecords?: mongoose.Types.ObjectId[];
  pendingBatchDocs: boolean;
  images: IProductImage[];
  isFeatured: boolean;
  isBestSeller: boolean;
  isNewProduct: boolean;
  seo?: IProductSeo;
  /** @deprecated currentBatchId is now per-variant. Kept for migration compatibility. */
  currentBatchId?: mongoose.Types.ObjectId;

  // Shopify CSV attributes
  vendor?: string;
  published: boolean;
  overviewHtml?: string;
  summaryHtml?: string;
  researchApplicationsHtml?: string;
  technicalSpecs?: {
    rawHtml?: string;
  };
  technicalSpecsTable?: {
    parameter: string;
    specification: string;
  }[];
  ratingCount: number;
  variants: IProductVariant[];

  // Shopify refinements
  productType?: string;
  barcode?: string;
  costPerItem?: number;
  countryOfOrigin?: string;
  hsCode?: string;
  chemicalGrade?: string;
  chemicalPurity?: string;
  chemicalColor?: string;

  createdAt: Date;
  updatedAt: Date;
}

const variantSchema = new mongoose.Schema<IProductVariant>({
  title: {
    type: String,
    required: true,
    default: 'Default Title',
  },
  sku: {
    type: String,
    required: true,
  },
  price: {
    type: Number,
    required: true,
    min: [0, 'Variant price must be positive'],
  },
  compareAtPrice: {
    type: Number,
    default: null,
  },
  stockQty: {
    type: Number,
    default: 0,
  },
  inventoryPolicy: {
    type: String,
    enum: ['deny', 'continue'],
    default: 'deny',
  },
  requiresShipping: {
    type: Boolean,
    default: true,
  },
  taxable: {
    type: Boolean,
    default: true,
  },
  weightGrams: {
    type: Number,
  },
  tagadaVariantId: {
    type: String,
    sparse: true,
  },
  currentBatchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    default: null,
  },
});

const productSchema = new mongoose.Schema<IProduct>(
  {
    id: {
      type: Number,
      required: [true, 'A product must have a numeric ID'],
      unique: true,
    },
    name: {
      type: String,
      required: [true, 'A product must have a name'],
      trim: true,
      unique: true,
    },
    slug: {
      type: String,
      unique: true,
      sparse: true,
    },
    description: {
      type: String,
      required: [true, 'A product must have a description'],
      default: 'Premium high-quality research compound for laboratory and scientific evaluation.',
    },
    price: {
      type: Number,
      required: [true, 'A product must have a price'],
      min: [0, 'Price must be positive'],
    },
    rating: {
      type: Number,
      default: 5.0,
      min: [1, 'Rating must be at least 1.0'],
      max: [5, 'Rating cannot exceed 5.0'],
    },
    inStock: {
      type: Boolean,
      default: true,
    },
    category: {
      type: String,
      required: [true, 'A product must have a category'],
      trim: true,
    },
    researchCategory: {
      type: String,
      enum: ['metabolic-pathway', 'tissue-cellular', 'dermal-pigmentation', 'laboratory-support'],
      required: true,
      default: 'laboratory-support',
    },
    // Legacy status (stock-based)
    status: {
      type: String,
      enum: ['In Stock', 'Sold Out', 'Sale'],
      default: 'In Stock',
    },
    // Shopify-equivalent lifecycle status
    publishStatus: {
      type: String,
      enum: ['active', 'draft', 'archived'],
      default: 'active',
    },
    // Legacy single tag (kept for backward compat)
    tag: {
      type: String,
      trim: true,
    },
    // Tags array (primary)
    tags: {
      type: [String],
      default: [],
    },
    reviewsCount: {
      type: Number,
      default: 0,
    },
    imageUrl: {
      type: String,
    },
    sku: {
      type: String,
      sparse: true,
    },
    tagadaVariantId: {
      type: String,
      trim: true,
    },
    compareAtPrice: {
      type: Number,
    },
    stockQuantity: {
      type: Number,
      default: 0,
    },
    lowStockThreshold: {
      type: Number,
      default: 5,
    },
    molecularFormula: {
      type: String,
      trim: true,
    },
    molecularWeight: {
      type: String,
      trim: true,
    },
    casNumber: {
      type: String,
      trim: true,
    },
    appearance: {
      type: String,
      trim: true,
    },
    purity: {
      type: String,
      trim: true,
      default: '≥99%',
    },
    researchApplications: {
      type: [String],
      default: [],
    },
    batchReference: {
      type: String,
      trim: true,
    },
    coaRecords: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'COA',
      },
    ],
    pendingBatchDocs: {
      type: Boolean,
      default: false,
    },
    images: [
      {
        url: { type: String, required: true },
        alt: { type: String },
        position: { type: Number },
      },
    ],
    isFeatured: {
      type: Boolean,
      default: false,
    },
    isBestSeller: {
      type: Boolean,
      default: false,
    },
    isNewProduct: {
      type: Boolean,
      default: false,
    },
    seo: {
      title: { type: String },
      description: { type: String },
      canonicalUrl: { type: String },
    },
    // Legacy root-level currentBatchId (deprecated — now per-variant)
    currentBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Batch',
    },

    // Expanded shopify integration
    vendor: {
      type: String,
      trim: true,
    },
    published: {
      type: Boolean,
      default: true,
    },
    overviewHtml: {
      type: String,
    },
    summaryHtml: {
      type: String,
    },
    researchApplicationsHtml: {
      type: String,
    },
    technicalSpecs: {
      rawHtml: { type: String },
    },
    technicalSpecsTable: [
      {
        parameter: { type: String, required: true },
        specification: { type: String, required: true }
      }
    ],
    ratingCount: {
      type: Number,
      default: 0,
    },
    variants: [variantSchema],

    // Shopify refinements
    productType: { type: String, trim: true },
    barcode: { type: String, trim: true },
    costPerItem: { type: Number, default: 0 },
    countryOfOrigin: { type: String, trim: true },
    hsCode: { type: String, trim: true },
    chemicalGrade: { type: String, trim: true },
    chemicalPurity: { type: String, trim: true },
    chemicalColor: { type: String, trim: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

productSchema.virtual('reviews', {
  ref: 'Review',
  localField: '_id',
  foreignField: 'product',
  match: { status: 'approved' }
});

// Pre-save hook: auto-generate slug from name if not set
productSchema.pre('save', function (next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = (this.name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
  next();
});

// Indexes
productSchema.index({ category: 1 });
productSchema.index({ price: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ publishStatus: 1 });

export const Product = mongoose.model<IProduct>('Product', productSchema);
export default Product;
