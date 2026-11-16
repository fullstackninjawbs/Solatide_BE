/**
 * Approximate visitor location from the request IP, looked up on our own server in a local
 * GeoIP database (.mmdb: DB-IP "IP to City Lite" or MaxMind GeoLite2 City), so it cannot be
 * blocked by ad blockers and no visitor IP is sent to a third party. The IP itself is not stored.
 *
 * GEOIP_DB_PATH = absolute path of the .mmdb file. Not set / missing file → null (the storefront's
 * own lookup is used as a fallback, as before). The file is re-read when it is replaced.
 */
import fs from 'fs';
import maxmind, { CityResponse, Reader } from 'maxmind';

export interface GeoLocation {
  country: string;
  countryCode: string;
  region: string;
  city: string;
}

let reader: Reader<CityResponse> | null = null;
let opening: Promise<void> | null = null;
let warned = false;

function open(): Promise<void> {
  if (!opening) {
    const file = (process.env.GEOIP_DB_PATH || '').trim();
    opening = (async () => {
      if (!file) return;
      if (!fs.existsSync(file)) {
        if (!warned) { warned = true; console.warn(`[Geo] GEOIP_DB_PATH file not found: ${file} — using the storefront location instead`); }
        return;
      }
      try {
        reader = await maxmind.open<CityResponse>(file, { watchForUpdates: true, watchForUpdatesNonPersistent: true });
        console.log(`[Geo] location database loaded: ${file}`);
      } catch (err: any) {
        console.error(`[Geo] could not open ${file}: ${err?.message}`);
      }
    })();
  }
  return opening;
}

const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:)/i;

export function normaliseIp(ip: unknown): string {
  const s = typeof ip === 'string' ? ip.trim() : '';
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

export async function lookupIp(ip: unknown): Promise<GeoLocation | null> {
  const addr = normaliseIp(ip);
  if (!addr || PRIVATE_IP.test(addr) || !maxmind.validate(addr)) return null;
  await open();
  if (!reader) return null;
  try {
    const r = reader.get(addr);
    if (!r?.country) return null;
    return {
      country: r.country.names?.en || r.country.iso_code || '',
      countryCode: r.country.iso_code || '',
      region: r.subdivisions?.[0]?.names?.en || '',
      city: r.city?.names?.en || '',
    };
  } catch {
    return null;
  }
}

/** Test helper: forget the opened database (the next lookup re-reads GEOIP_DB_PATH). */
export function resetGeoForTests(): void {
  reader = null;
  opening = null;
  warned = false;
}
