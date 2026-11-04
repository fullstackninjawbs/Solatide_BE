/**
 * Where a session came from, decided once from its landing request: ad click IDs and UTM tags
 * first (explicit), then the referring site, else Direct. Same rules as the storefront's order
 * attribution (Client/src/utils/attribution.ts), extended with more sites.
 *
 * channel: paid_search | paid_social | organic_search | organic_social | email | referral | ai | direct
 * source:  what the dashboard shows, e.g. "Google Organic", "Instagram Ads", "Direct"
 */
export interface TrafficInput {
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  ttclid?: string;
  msclkid?: string;
}

export interface TrafficSource {
  source: string;
  channel: string;
  referrerDomain: string;
  campaign?: string;
}

const PAID_MEDIA = ['cpc', 'ppc', 'paid', 'paid_search', 'paid_social', 'paidsocial', 'display', 'cpm', 'ad', 'ads'];

const SEARCH: Array<[RegExp, string]> = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)yahoo\./, 'Yahoo'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)ecosia\.org$/, 'Ecosia'],
  [/(^|\.)baidu\.com$/, 'Baidu'],
  [/(^|\.)yandex\./, 'Yandex'],
  [/(^|\.)brave\.com$/, 'Brave Search'],
];
const SOCIAL: Array<[RegExp, string]> = [
  [/(^|\.)(instagram\.com|l\.instagram\.com)$/, 'Instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'Facebook'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)(x\.com|twitter\.com|t\.co)$/, 'X (Twitter)'],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, 'LinkedIn'],
  [/(^|\.)pinterest\./, 'Pinterest'],
  [/(^|\.)snapchat\.com$/, 'Snapchat'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'WhatsApp'],
  [/(^|\.)(telegram\.org|t\.me)$/, 'Telegram'],
  [/(^|\.)discord(app)?\.com$/, 'Discord'],
];
const AI: Array<[RegExp, string]> = [
  [/(^|\.)(chatgpt\.com|openai\.com)$/, 'ChatGPT'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity'],
  [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)gemini\.google\.com$/, 'Gemini'],
  [/(^|\.)copilot\.microsoft\.com$/, 'Copilot'],
];

const hostOf = (url: string | undefined): string => {
  try { return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; }
};
const match = (list: Array<[RegExp, string]>, host: string) => (list.find(([re]) => re.test(host)) || [])[1];
const fromSourceName = (list: Array<[RegExp, string]>, s: string) => list.find(([, name]) => s.includes(name.toLowerCase().split(' ')[0]))?.[1];

export function classifyTrafficSource(input: TrafficInput, siteHosts: string[] = []): TrafficSource {
  const s = (input.utmSource || '').trim().toLowerCase();
  const m = (input.utmMedium || '').trim().toLowerCase();
  const campaign = input.utmCampaign?.trim() || undefined;
  let referrerDomain = hostOf(input.referrer);
  // Our own pages / payment return are not a source
  if (referrerDomain && siteHosts.some((h) => referrerDomain === h || referrerDomain.endsWith(`.${h}`))) referrerDomain = '';
  const paid = PAID_MEDIA.includes(m);
  const out = (source: string, channel: string): TrafficSource => ({ source, channel, referrerDomain, ...(campaign ? { campaign } : {}) });

  // 1. Ad click IDs / paid UTMs
  if (input.gclid || input.gbraid || input.wbraid || (s.includes('google') && paid)) return out('Google Ads', 'paid_search');
  if (input.msclkid || (s.includes('bing') && paid)) return out('Microsoft Ads', 'paid_search');
  if (input.ttclid || (s.includes('tiktok') && paid)) return out('TikTok Ads', 'paid_social');
  const metaSource = /facebook|instagram|^fb$|^ig$|meta/.test(s);
  if ((metaSource || input.fbclid) && paid) return out(/instagram|^ig$/.test(s) ? 'Instagram Ads' : 'Facebook Ads', 'paid_social');

  // 2. Other UTM tags (newsletters, partners, organic social posts)
  if (m === 'email' || m === 'newsletter' || s === 'newsletter') return out('Email', 'email');
  if (s) {
    const social = fromSourceName(SOCIAL, s);
    if (social) return out(paid ? `${social} Ads` : `${social} Organic`, paid ? 'paid_social' : 'organic_social');
    const search = fromSourceName(SEARCH, s);
    if (search) return out(paid ? `${search} Ads` : `${search} Organic`, paid ? 'paid_search' : 'organic_search');
    return out(input.utmSource!.trim().slice(0, 60), paid ? 'paid_other' : 'referral');
  }

  // 3. Referring site
  if (referrerDomain) {
    const ai = match(AI, referrerDomain);
    if (ai) return out(ai, 'ai');
    const search = match(SEARCH, referrerDomain);
    if (search) return out(`${search} Organic`, 'organic_search');
    const social = match(SOCIAL, referrerDomain);
    if (social) return out(`${social} Organic`, 'organic_social');
    return out(referrerDomain, 'referral');
  }
  // fbclid without a paid signal = a shared link opened from Facebook/Instagram
  if (input.fbclid) return out('Facebook / Instagram', 'organic_social');

  return out('Direct', 'direct');
}
