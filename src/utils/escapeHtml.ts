/**
 * Escape a value for safe interpolation into HTML text or a quoted attribute.
 * null/undefined become ''.
 */
export const escapeHtml = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
};

/**
 * Return an HTML-escaped URL only if it uses http(s); otherwise ''.
 * Use for href/src attributes built from stored data.
 */
export const safeUrl = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return escapeHtml(u.toString());
  } catch {
    return '';
  }
};

export default escapeHtml;
