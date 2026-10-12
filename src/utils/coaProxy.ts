import https from 'https';

/**
 * SSRF-hardened fetch of COA documents from this account's Cloudinary.
 * - https only, hostname exactly res.cloudinary.com, default port, no credentials
 * - path must start with /<CLOUDINARY_CLOUD_NAME>/
 * - redirects are NOT followed, 10s timeout, 25MB cap
 * - only application/pdf or image/* responses are passed through
 */
export const COA_MAX_BYTES = 25 * 1024 * 1024;
export const COA_TIMEOUT_MS = 10_000;

export type CoaUrlCheck = { ok: true; url: URL } | { ok: false; status: number; message: string };

export const validateCoaUrl = (raw: string, cloudName = process.env.CLOUDINARY_CLOUD_NAME || ''): CoaUrlCheck => {
  if (!cloudName) {
    return { ok: false, status: 503, message: 'COA proxy is not configured' };
  }
  if (typeof raw !== 'string' || raw.length > 2048) {
    return { ok: false, status: 400, message: 'Invalid COA URL' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 400, message: 'Invalid COA URL' };
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'res.cloudinary.com' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith(`/${cloudName}/`) ||
    url.pathname.includes('/../') ||
    url.pathname.includes('%2e%2e') ||
    url.pathname.includes('%2E%2E')
  ) {
    return { ok: false, status: 400, message: 'COA URL must point to this store\'s Cloudinary account' };
  }
  return { ok: true, url };
};

export type CoaFetchResult =
  | { ok: true; contentType: string; body: Buffer }
  | { ok: false; status: number; message: string };

const isAllowedType = (ct: string) => ct === 'application/pdf' || ct.startsWith('image/');

export const fetchCloudinaryCoa = (raw: string): Promise<CoaFetchResult> => {
  const check = validateCoaUrl(raw);
  if (!check.ok) return Promise.resolve(check);
  const { url } = check;

  return new Promise<CoaFetchResult>((resolve) => {
    let settled = false;
    const done = (r: CoaFetchResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const req = https.get(
      {
        protocol: 'https:',
        hostname: 'res.cloudinary.com',
        port: 443,
        path: url.pathname + url.search,
        headers: { Accept: 'application/pdf,image/*' },
        timeout: COA_TIMEOUT_MS,
      },
      (upstream) => {
        // No redirects: anything other than 200 is a failure
        if (upstream.statusCode !== 200) {
          upstream.resume();
          return done({ ok: false, status: 502, message: 'Failed to fetch COA document' });
        }
        const ct = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!isAllowedType(ct)) {
          upstream.resume();
          return done({ ok: false, status: 502, message: 'Unsupported COA document type' });
        }
        const declared = parseInt(String(upstream.headers['content-length'] || '0'), 10);
        if (declared > COA_MAX_BYTES) {
          upstream.destroy();
          return done({ ok: false, status: 502, message: 'COA document too large' });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        upstream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > COA_MAX_BYTES) {
            upstream.destroy();
            done({ ok: false, status: 502, message: 'COA document too large' });
            return;
          }
          chunks.push(chunk);
        });
        upstream.on('end', () => done({ ok: true, contentType: ct, body: Buffer.concat(chunks) }));
        upstream.on('error', () => done({ ok: false, status: 502, message: 'Error proxying COA' }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, status: 504, message: 'COA fetch timed out' });
    });
    req.on('error', () => done({ ok: false, status: 502, message: 'Error proxying COA' }));
  });
};
