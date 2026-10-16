/**
 * One URL-handle format for products and collections (CMS pages validate the same format):
 * lowercase letters, numbers and single hyphens, no leading/trailing hyphen.
 *   "Selank + Semax 20mg" → "selank-semax-20mg"
 */
export function slugify(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
