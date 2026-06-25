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
}

export interface IProduct extends mongoose.Document {
  id: number; // numeric id for backward compatibility fallback
  name: string;
  description: string;
  price: number; // base price (e.g. minimum variant price)
  rating: number;
  inStock: boolean;
  category: string;
  status: 'In Stock' | 'Sold Out' | 'Sale';
  tag?: string;
  reviewsCount?: number;
  imageUrl?: string;
  sku?: string;
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
  
  // New Shopify CSV attributes
  slug?: string;
  vendor?: string;
  published: boolean;
  overviewHtml?: string;
  summaryHtml?: string;
  researchApplicationsHtml?: string;
  technicalSpecs?: {
    rawHtml?: string;
  };
  ratingCount: number;
  variants: IProductVariant[];
  
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
    status: {
      type: String,
      enum: ['In Stock', 'Sold Out', 'Sale'],
      default: 'In Stock',
    },
    tag: {
      type: String,
      trim: true,
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
      title: { type: String, trim: true },
      description: { type: String, trim: true },
      canonicalUrl: { type: String, trim: true },
    },
    
    // Expanded shopify integration
    slug: {
      type: String,
      unique: true,
      sparse: true,
    },
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
    ratingCount: {
      type: Number,
      default: 0,
    },
    variants: [variantSchema],
  },
  {
    timestamps: true,
  }
);

// Indexes
productSchema.index({ category: 1 });
productSchema.index({ price: 1 });

export const Product = mongoose.model<IProduct>('Product', productSchema);
export default Product;
