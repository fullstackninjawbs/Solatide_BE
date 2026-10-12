/**
 * rebuildStorefront.ts — single-flight storefront rebuilds across PM2 workers (M-16).
 *
 * - Debounced per process (10 s).
 * - Cross-process single flight via an exclusive lock file in CLIENT_DIR
 *   (fs.openSync(lock, 'wx')); a lock older than 30 min is treated as stale.
 * - A rebuild requested while another build is running (in any worker) sets a
 *   'dirty' marker; the worker that finishes the build runs exactly one
 *   follow-up build if the marker is present.
 * - deploy-store.sh is spawned (no shell), output appended to
 *   CLIENT_DIR/logs/deploy-<YYYY-MM-DD>.log. Exit code 75 means the script's own
 *   flock is busy → treated as "busy", the dirty marker schedules a retry.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEBOUNCE_MS = 10_000;
const STALE_LOCK_MS = 30 * 60 * 1000;
const BUSY_RETRY_MS = 60_000;
const EXIT_BUSY = 75;

let rebuildTimeout: NodeJS.Timeout | null = null;

function clientDir(): string {
  return process.env.CLIENT_DIR || path.join(__dirname, '../../../Client');
}

function paths() {
  const dir = clientDir();
  return {
    dir,
    lock: path.join(dir, '.storefront-rebuild.lock'),
    dirty: path.join(dir, '.storefront-rebuild.dirty'),
    logDir: path.join(dir, 'logs'),
  };
}

/** Try to take the cross-process lock. Returns a release function or null if busy. */
export function acquireRebuildLock(lockPath: string, now = Date.now()): (() => void) | null {
  const tryOpen = (): number | null => {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (err: any) {
      if (err?.code === 'EEXIST') return null;
      throw err;
    }
  };

  let fd = tryOpen();
  if (fd === null) {
    try {
      const age = now - fs.statSync(lockPath).mtimeMs;
      if (age > STALE_LOCK_MS) {
        console.warn(`[Storefront] Removing stale rebuild lock (${Math.round(age / 60000)} min old)`);
        fs.unlinkSync(lockPath);
        fd = tryOpen();
      }
    } catch {
      fd = tryOpen();
    }
  }
  if (fd === null) return null;

  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, instance: process.env.NODE_APP_INSTANCE ?? null, at: new Date(now).toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}

function markDirty(dirtyPath: string) {
  try {
    fs.writeFileSync(dirtyPath, new Date().toISOString());
  } catch (err: any) {
    console.error(`[Storefront] Could not write dirty marker: ${err?.message}`);
  }
}

/** Consume the dirty marker; true if one was present. */
function consumeDirty(dirtyPath: string): boolean {
  try {
    fs.unlinkSync(dirtyPath);
    return true;
  } catch {
    return false;
  }
}

function runDeploy(): Promise<number> {
  const { dir, logDir } = paths();
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `deploy-${new Date().toISOString().slice(0, 10)}.log`);
  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} deploy-store.sh (pid ${process.pid}) =====\n`);

  return new Promise((resolve) => {
    const child = spawn('bash', ['scripts/deploy-store.sh'], { cwd: dir, stdio: ['ignore', out, out] });
    child.on('error', (err) => {
      console.error(`[Storefront] Failed to start deploy-store.sh: ${err.message}`);
      fs.closeSync(out);
      resolve(-1);
    });
    child.on('close', (code) => {
      fs.closeSync(out);
      resolve(code ?? -1);
    });
  });
}

async function buildLoop(): Promise<void> {
  const { lock, dirty } = paths();
  const release = acquireRebuildLock(lock);
  if (!release) {
    console.log('⏳ A storefront rebuild is already running (another worker). Marked dirty for a follow-up build.');
    markDirty(dirty);
    return;
  }

  // Heartbeat so a long build is not mistaken for a stale lock.
  const heartbeat = setInterval(() => {
    try { const t = new Date(); fs.utimesSync(lock, t, t); } catch { /* ignore */ }
  }, 5 * 60 * 1000);
  let busyExit = false;

  try {
    // Run once, then exactly one more time per batch of requests that arrived meanwhile.
    consumeDirty(dirty);
    for (;;) {
      console.log('🚀 Starting atomic storefront deployment (deploy-store.sh)...');
      const code = await runDeploy();
      if (code === 0) {
        console.log('✅ Atomic storefront deployment completed successfully.');
      } else if (code === EXIT_BUSY) {
        console.warn('⏳ deploy-store.sh reported busy (exit 75); retrying later.');
        markDirty(dirty);
        busyExit = true;
        setTimeout(triggerStorefrontRebuild, BUSY_RETRY_MS).unref?.();
        return;
      } else {
        console.error(`❌ Atomic storefront deployment failed (exit ${code}). See CLIENT_DIR/logs/deploy-*.log`);
      }
      if (!consumeDirty(dirty)) break;
      console.log('🔁 Changes arrived during the build — running one follow-up build.');
    }
  } finally {
    clearInterval(heartbeat);
    release();
  }
  // A request may have marked dirty between our last check and the release.
  if (!busyExit && fs.existsSync(dirty)) triggerStorefrontRebuild();
}

/**
 * Debounced, single-flight rebuild request. Safe to call from any PM2 worker.
 */
export const triggerStorefrontRebuild = () => {
  // Never deploy from tests; STOREFRONT_AUTO_REBUILD=false disables it explicitly (e.g. local dev).
  if (process.env.NODE_ENV === 'test' || process.env.STOREFRONT_AUTO_REBUILD === 'false') return;
  console.log('🔄 Storefront rebuild requested (debounced 10 s).');
  if (rebuildTimeout) clearTimeout(rebuildTimeout);
  rebuildTimeout = setTimeout(() => {
    rebuildTimeout = null;
    buildLoop().catch((err) => console.error(`[Storefront] Rebuild loop error: ${err?.message}`));
  }, DEBOUNCE_MS);
};
