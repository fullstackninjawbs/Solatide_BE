/**
 * The running backend's version: package.json "version" (semantic versioning, see CHANGELOG.md)
 * and the git commit it was built from. Available to staff at GET /api/admin/version (the public
 * /api/health deliberately reveals no version) and logged at startup, so it is always clear exactly
 * which release is live. (Not shown in the admin UI at the moment.)
 *
 * Commit: APP_COMMIT env (set it in the deploy if the server folder is not a git checkout), else
 * `git rev-parse` in the server folder, else "unknown".
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.join(__dirname, '..', '..'); // Server/ (from src/config or dist/config)

function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readCommit(): string {
  const fromEnv = (process.env.APP_COMMIT || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 7);
  try {
    const out = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
      .toString().trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const APP_VERSION = readVersion();
export const APP_COMMIT = readCommit();
export const APP_STARTED_AT = new Date().toISOString();

export const versionInfo = () => ({
  version: APP_VERSION,
  commit: APP_COMMIT,
  startedAt: APP_STARTED_AT,
  node: process.version,
});
