/** Escape a user-supplied string for safe use inside a RegExp / Mongo $regex. */
export function escapeRegExp(input: string, maxLength = 100): string {
  return String(input).slice(0, maxLength).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
