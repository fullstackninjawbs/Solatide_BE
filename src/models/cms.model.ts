import mongoose from 'mongoose';

// FAQ Schema
export interface IFaqQuestion {
  question: string;
  answer: string;
  isVisible: boolean;
  sortOrder: number;
}

export interface IFaqSection extends mongoose.Document {
  name: string;
  sortOrder: number;
  questions: IFaqQuestion[];
  createdAt: Date;
  updatedAt: Date;
}

const faqSectionSchema = new mongoose.Schema<IFaqSection>(
  {
    name: {
      type: String,
      required: [true, 'An FAQ section must have a name'],
      trim: true,
      unique: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    questions: [
      {
        question: { type: String, required: true, trim: true },
        answer: { type: String, required: true, trim: true },
        isVisible: { type: Boolean, default: true },
        sortOrder: { type: Number, default: 0 },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Static Pages Schema
export interface IStaticPage extends mongoose.Document {
  title: string;
  slug: string;
  richTextBody: string;
  heroSubtitle?: string;
  introText?: string;
  relatedProducts?: mongoose.Types.ObjectId[];
  seo?: {
    title?: string;
    description?: string;
    canonicalUrl?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const staticPageSchema = new mongoose.Schema<IStaticPage>(
  {
    title: {
      type: String,
      required: [true, 'A page must have a title'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'A page must have a slug'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    richTextBody: {
      type: String,
      required: [true, 'A page must have body content'],
    },
    heroSubtitle: {
      type: String,
    },
    introText: {
      type: String,
    },
    relatedProducts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
      },
    ],
    seo: {
      title: { type: String, trim: true },
      description: { type: String, trim: true },
      canonicalUrl: { type: String, trim: true },
    },
  },
  {
    timestamps: true,
  }
);

// Research Library Entry (Compound Overview & Comparison)
export interface IResearchLibraryEntry extends mongoose.Document {
  title: string;
  slug: string;
  type: 'overview' | 'comparison';
  content: string;
  linkedProducts: mongoose.Types.ObjectId[];
  category: 'GLP-1' | 'triple_agonist' | 'blend' | 'repair' | 'dermal' | 'metabolic' | 'other';
  createdAt: Date;
  updatedAt: Date;
}

const researchLibraryEntrySchema = new mongoose.Schema<IResearchLibraryEntry>(
  {
    title: {
      type: String,
      required: [true, 'A research library entry must have a title'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'A research library entry must have a slug'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['overview', 'comparison'],
      required: true,
    },
    content: {
      type: String,
      required: [true, 'Content is required'],
    },
    linkedProducts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
      },
    ],
    category: {
      type: String,
      enum: ['GLP-1', 'triple_agonist', 'blend', 'repair', 'dermal', 'metabolic', 'other'],
      default: 'other',
    },
  },
  {
    timestamps: true,
  }
);

export const FaqSection = mongoose.model<IFaqSection>('FaqSection', faqSectionSchema);
export const StaticPage = mongoose.model<IStaticPage>('StaticPage', staticPageSchema);
export const ResearchLibraryEntry = mongoose.model<IResearchLibraryEntry>('ResearchLibraryEntry', researchLibraryEntrySchema);
