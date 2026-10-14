import sanitizeHtmlLib from 'sanitize-html';
import { repairEditorLinks } from './repairEditorLinks';

/**
 * Single shared sanitize-html configuration for every admin-authored rich-HTML
 * field (CMS pages, product HTML fields, FAQ answers). Stored HTML is rendered with
 * dangerouslySetInnerHTML on the storefront, so it must be safe on write.
 */

const COLOR = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/i,
  /^[a-z]{3,20}$/i, // named colours (e.g. "red", "transparent")
];
const SIZE = [/^\d{1,4}(?:\.\d{1,2})?(?:px|%)$/];

export const RICH_HTML_OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins',
    'sup', 'sub', 'small', 'mark', 'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'img', 'figure', 'figcaption',
    'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'blockquote', 'hr', 'pre', 'code', 'br', 'span', 'div',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    col: ['span'],
    colgroup: ['span'],
    ol: ['start', 'type'],
    // NOTE: no `id` (DOM clobbering / anchor hijack), no event handlers.
    '*': ['class', 'style'],
  },
  allowedStyles: {
    '*': {
      color: COLOR,
      'background-color': COLOR,
      'text-align': [/^(?:left|right|center|justify|start|end)$/],
      'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/],
      'font-style': [/^(?:normal|italic|oblique)$/],
      'text-decoration': [/^(?:none|underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*$/],
      width: SIZE,
      height: SIZE,
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const out: Record<string, string> = { ...attribs };
      if (out.target && out.target !== '_blank' && out.target !== '_self') {
        delete out.target;
      }
      if (out.target === '_blank') {
        out.rel = 'noopener noreferrer';
      }
      return { tagName, attribs: out };
    },
  },
};

/**
 * Sanitize one rich-HTML string. Non-strings become ''.
 * First repairs nested empty links left by the Jodit editor (see repairEditorLinks).
 */
export const sanitizeRichHtml = (html: unknown): string => {
  if (typeof html !== 'string' || html === '') return '';
  return sanitizeHtmlLib(repairEditorLinks(html), RICH_HTML_OPTIONS);
};

/** Product fields that contain HTML rendered on the storefront. */
export const PRODUCT_HTML_FIELDS = ['description', 'overviewHtml', 'summaryHtml', 'researchApplicationsHtml'] as const;

/**
 * Sanitize product HTML fields in place on a plain object (create/update payloads,
 * CSV-parsed products). Only touches fields that are present.
 */
export const sanitizeProductHtmlFields = <T extends Record<string, any>>(data: T): T => {
  if (!data || typeof data !== 'object') return data;
  const d = data as Record<string, any>;
  for (const field of PRODUCT_HTML_FIELDS) {
    if (d[field] !== undefined && d[field] !== null) {
      d[field] = sanitizeRichHtml(d[field]);
    }
  }
  if (d.technicalSpecs && typeof d.technicalSpecs === 'object' && d.technicalSpecs.rawHtml !== undefined) {
    d.technicalSpecs = { ...d.technicalSpecs, rawHtml: sanitizeRichHtml(d.technicalSpecs.rawHtml) };
  }
  if (typeof d['technicalSpecs.rawHtml'] === 'string') {
    d['technicalSpecs.rawHtml'] = sanitizeRichHtml(d['technicalSpecs.rawHtml']);
  }
  return data;
};

export default sanitizeRichHtml;
