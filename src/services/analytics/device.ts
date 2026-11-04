/**
 * Device, OS and browser from the User-Agent (no third-party parser). In-app browsers (Instagram,
 * Facebook, TikTok) are named because they tell where the visitor came from.
 *
 * iPadOS reports a desktop Mac User-Agent; the storefront sends `touch: true` for touch screens so
 * an iPad is not shown as a desktop.
 */
export type DeviceType = 'mobile' | 'tablet' | 'desktop';

export interface DeviceInfo {
  type: DeviceType;
  /** What the dashboard shows: "iPhone", "iPad", "Android phone", "Android tablet", "Desktop" */
  label: string;
  os: string;
  browser: string;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Instagram/i, 'Instagram app'],
  [/FBAN|FBAV|FB_IAB|FBIOS/i, 'Facebook app'],
  [/BytedanceWebview|musical_ly|TikTok/i, 'TikTok app'],
  [/SamsungBrowser/i, 'Samsung Internet'],
  [/Edg(e|A|iOS)?\//i, 'Edge'],
  [/OPR\/|Opera/i, 'Opera'],
  [/Firefox|FxiOS/i, 'Firefox'],
  [/CriOS|Chrome\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
];

export function parseUserAgent(ua: unknown, hints: { touch?: boolean } = {}): DeviceInfo {
  const s = typeof ua === 'string' ? ua : '';

  let os = 'Other';
  if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Macintosh|Mac OS X/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  const iPadDesktopMode = os === 'macOS' && hints.touch === true;
  let type: DeviceType = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(s) || iPadDesktopMode || (os === 'Android' && !/Mobile/i.test(s))) type = 'tablet';
  else if (/Mobi|iPhone|iPod|Windows Phone/i.test(s)) type = 'mobile';

  const browser = (BROWSERS.find(([re]) => re.test(s)) || [null, 'Other'])[1];

  let label = 'Desktop';
  if (/iPhone|iPod/i.test(s)) label = 'iPhone';
  else if (/iPad/i.test(s) || iPadDesktopMode) { label = 'iPad'; if (iPadDesktopMode) os = 'iOS'; }
  else if (os === 'Android') label = type === 'tablet' ? 'Android tablet' : 'Android phone';
  else if (type === 'mobile') label = 'Mobile';
  else if (type === 'tablet') label = 'Tablet';

  return { type, label, os, browser };
}
