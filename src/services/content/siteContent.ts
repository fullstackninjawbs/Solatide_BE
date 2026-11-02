/**
 * Homepage content (hero + announcement bar): built-in defaults, validation of Hub input, and the
 * merged view served to the storefront and the Hub.
 *
 * The defaults are the texts the storefront shipped with; keep them in sync with
 * Client/src/hooks/useHomepageContent.js (used when the API is unreachable). Images have no
 * server default: null = the storefront's built-in image.
 */
import SiteContent, { ANNOUNCEMENT_ICONS, type AnnouncementIcon, type ContentImage } from '../../models/SiteContent';

export const HOMEPAGE_KEY = 'homepage';

export const LIMITS = {
  headline: 120,
  headlineLines: 3,
  subtext: 400,
  imageAlt: 160,
  messages: 4,
  messageText: 80,
} as const;

export interface HomepageContent {
  hero: {
    headline: string;
    subtext: string;
    imageAlt: string;
    desktopImage: ContentImage | null;
    mobileImage: ContentImage | null;
  };
  announcement: {
    enabled: boolean;
    messages: Array<{ text: string; icon: AnnouncementIcon }>;
  };
  updatedAt: string | null;
}

export const HOMEPAGE_DEFAULTS: HomepageContent = {
  hero: {
    headline: 'Your Trusted Source For\nResearch Grade Peptides.',
    subtext: 'Solatide Biosciences delivers research grade peptides and laboratory solutions for researchers who demand purity, consistency, and results.',
    imageAlt: 'Solatide Biosciences – Research Grade Peptides',
    desktopImage: null,
    mobileImage: null,
  },
  announcement: {
    enabled: true,
    messages: [
      { text: 'Australian owned & operated', icon: 'au_flag' },
      { text: 'Card Payments Available', icon: 'card_logos' },
    ],
  },
  updatedAt: null,
};

export class ContentInputError extends Error {
  statusCode = 400;
}

const cleanImage = (img: any): ContentImage | null =>
  img && img.url ? { url: String(img.url), width: Number(img.width) || 0, height: Number(img.height) || 0 } : null;

/** Stored document (or none) merged over the defaults. */
export function mergeHomepage(doc: any): HomepageContent {
  const d = HOMEPAGE_DEFAULTS;
  const hero = doc?.hero || {};
  const ann = doc?.announcement || {};
  const messages = Array.isArray(ann.messages) && ann.messages.length
    ? ann.messages.map((m: any) => ({ text: String(m.text || ''), icon: (ANNOUNCEMENT_ICONS as readonly string[]).includes(m.icon) ? m.icon : 'none' }))
    : d.announcement.messages;
  return {
    hero: {
      headline: hero.headline || d.hero.headline,
      subtext: hero.subtext || d.hero.subtext,
      imageAlt: hero.imageAlt || d.hero.imageAlt,
      desktopImage: cleanImage(hero.desktopImage),
      mobileImage: cleanImage(hero.mobileImage),
    },
    announcement: {
      enabled: ann.enabled !== false,
      messages,
    },
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export async function getHomepageContent(): Promise<HomepageContent> {
  const doc = await SiteContent.findOne({ key: HOMEPAGE_KEY }).lean();
  return mergeHomepage(doc);
}

const text = (v: unknown, field: string, max: number, required: boolean): string => {
  if (v !== undefined && v !== null && typeof v !== 'string') throw new ContentInputError(`${field} must be text.`);
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  if (required && !s) throw new ContentInputError(`${field} is required.`);
  if (s.length > max) throw new ContentInputError(`${field} must be at most ${max} characters.`);
  return s;
};

/** Images must come from our own Cloudinary account (uploaded through the Hub). */
const image = (v: unknown, field: string, cloudName: string): ContentImage | null => {
  if (v === null || v === undefined || v === '') return null;
  const img = v as any;
  const url = typeof img?.url === 'string' ? img.url : '';
  const prefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
  if (!cloudName || !url.startsWith(prefix) || url.length > 500 || /["'<>\s]/.test(url)) {
    throw new ContentInputError(`${field}: please upload the image through the Hub.`);
  }
  const width = Math.round(Number(img.width));
  const height = Math.round(Number(img.height));
  if (!(width > 0 && width <= 10000 && height > 0 && height <= 10000)) {
    throw new ContentInputError(`${field}: image size is missing, please upload it again.`);
  }
  return { url, width, height };
};

/** Validates the Hub's PUT body; returns what is stored. */
export function validateHomepageInput(body: any, cloudName: string) {
  const hero = body?.hero || {};
  const ann = body?.announcement || {};

  const headline = text(hero.headline, 'Headline', LIMITS.headline, true).replace(/\n{2,}/g, '\n');
  if (headline.split('\n').length > LIMITS.headlineLines) {
    throw new ContentInputError(`Headline can have at most ${LIMITS.headlineLines} lines.`);
  }
  const subtext = text(hero.subtext, 'Paragraph', LIMITS.subtext, true).replace(/\s*\n\s*/g, ' ');
  const imageAlt = text(hero.imageAlt, 'Image description', LIMITS.imageAlt, false);

  if (!Array.isArray(ann.messages) || ann.messages.length < 1) {
    throw new ContentInputError('Add at least one announcement message.');
  }
  if (ann.messages.length > LIMITS.messages) {
    throw new ContentInputError(`At most ${LIMITS.messages} announcement messages.`);
  }
  const messages = ann.messages.map((m: any, i: number) => {
    const icon = m?.icon ?? 'none';
    if (!(ANNOUNCEMENT_ICONS as readonly string[]).includes(icon)) throw new ContentInputError(`Message ${i + 1}: unknown icon.`);
    return { text: text(m?.text, `Message ${i + 1}`, LIMITS.messageText, true).replace(/\s*\n\s*/g, ' '), icon: icon as AnnouncementIcon };
  });

  return {
    hero: {
      headline,
      subtext,
      imageAlt,
      desktopImage: image(hero.desktopImage, 'Desktop image', cloudName),
      mobileImage: image(hero.mobileImage, 'Mobile image', cloudName),
    },
    announcement: {
      enabled: ann.enabled !== false,
      messages,
    },
  };
}

export async function saveHomepageContent(input: ReturnType<typeof validateHomepageInput>, updatedBy: string): Promise<HomepageContent> {
  let doc = await SiteContent.findOne({ key: HOMEPAGE_KEY });
  if (doc) {
    // "Save" with nothing changed: no write, so no storefront rebuild
    const current = { hero: mergeHomepage(doc.toObject()).hero, announcement: mergeHomepage(doc.toObject()).announcement };
    if (JSON.stringify(current) === JSON.stringify({ hero: input.hero, announcement: input.announcement })) {
      return mergeHomepage(doc.toObject());
    }
  } else {
    doc = new SiteContent({ key: HOMEPAGE_KEY });
  }
  doc.set('hero', input.hero);
  doc.set('announcement', input.announcement);
  doc.set('updatedBy', updatedBy);
  await doc.save();
  return mergeHomepage(doc.toObject());
}
