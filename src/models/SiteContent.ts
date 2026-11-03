import mongoose from 'mongoose';
import { registerStorefrontRebuildHooks } from '../utils/storefrontRebuildHooks';

/**
 * Editable storefront content (Hub → Content → Homepage): one document per `key`.
 * 'homepage' holds the hero text/images and the announcement bar. Empty / missing values mean
 * "use the built-in default" (see services/content/siteContent.ts). Every change rebuilds the
 * prerendered storefront.
 */
export const ANNOUNCEMENT_ICONS = ['none', 'au_flag', 'card_logos'] as const;
export type AnnouncementIcon = (typeof ANNOUNCEMENT_ICONS)[number];

export interface ContentImage {
  url: string;
  width: number;
  height: number;
}

export interface ISiteContent extends mongoose.Document {
  key: string;
  hero?: {
    headline?: string;
    subtext?: string;
    imageAlt?: string;
    primaryButtonText?: string;
    secondaryButtonText?: string;
    disclaimer?: string;
    showBadge?: boolean;
    badgeTitle?: string;
    badgeSubtitle?: string;
    badgeLinkText?: string;
    desktopImage?: ContentImage | null;
    mobileImage?: ContentImage | null;
  };
  announcement?: {
    enabled?: boolean;
    messages?: Array<{ text: string; icon: AnnouncementIcon }>;
  };
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const imageSchema = new mongoose.Schema(
  { url: { type: String, required: true }, width: Number, height: Number },
  { _id: false }
);

const siteContentSchema = new mongoose.Schema<ISiteContent>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    hero: {
      headline: String,
      subtext: String,
      imageAlt: String,
      primaryButtonText: String,
      secondaryButtonText: String,
      disclaimer: String,
      showBadge: { type: Boolean, default: true }, // PepFinder badge card
      badgeTitle: String,
      badgeSubtitle: String,
      badgeLinkText: String,
      desktopImage: { type: imageSchema, default: null },
      mobileImage: { type: imageSchema, default: null },
    },
    announcement: {
      enabled: { type: Boolean, default: true },
      messages: {
        type: [new mongoose.Schema({ text: String, icon: { type: String, enum: ANNOUNCEMENT_ICONS, default: 'none' } }, { _id: false })],
        default: undefined,
      },
    },
    updatedBy: String,
  },
  { timestamps: true }
);

registerStorefrontRebuildHooks(siteContentSchema);
const SiteContent = mongoose.model<ISiteContent>('SiteContent', siteContentSchema);
export default SiteContent;
