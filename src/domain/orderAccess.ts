import crypto from 'crypto';

/** 256-bit random hex token that authorises public (guest) access to one order. */
export function generateOrderAccessToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time comparison; false for missing/mismatched-length tokens. */
export function accessTokenMatches(expected: string | null | undefined, provided: unknown): boolean {
  if (typeof expected !== 'string' || !expected || typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
