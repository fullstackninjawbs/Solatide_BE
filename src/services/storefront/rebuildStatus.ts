/**
 * Storefront rebuild status: when a rebuild was last requested, started and finished, and how it
 * ended. Shown in Admin → Settings → Store ("Storefront updates"), and used to email the admins
 * when a rebuild fails (a failed build keeps the previous version live, so admin changes would
 * otherwise silently never reach the website).
 *
 * Every function here is best-effort: it never throws and never blocks a rebuild.
 */
import mongoose from 'mongoose';

const KEY = 'storefront';
/** At most one failure email per this period while builds keep failing. */
const ALERT_EVERY_MS = 60 * 60 * 1000;

export interface RebuildStatus {
  lastRequestedAt?: Date;
  lastRequestedBy?: string;
  building?: boolean;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastResult?: 'success' | 'failed' | 'busy';
  lastExitCode?: number;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  consecutiveFailures?: number;
  lastAlertAt?: Date;
}

const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    lastRequestedAt: Date,
    lastRequestedBy: String,
    building: { type: Boolean, default: false },
    lastStartedAt: Date,
    lastFinishedAt: Date,
    lastResult: { type: String, enum: ['success', 'failed', 'busy'] },
    lastExitCode: Number,
    lastSuccessAt: Date,
    lastFailureAt: Date,
    consecutiveFailures: { type: Number, default: 0 },
    lastAlertAt: Date,
  },
  { collection: 'storefrontrebuildstatus', timestamps: true }
);

export const StorefrontRebuildStatus: mongoose.Model<any> =
  (mongoose.models.StorefrontRebuildStatus as mongoose.Model<any>) || mongoose.model('StorefrontRebuildStatus', schema);

const dbReady = () => mongoose.connection.readyState === 1;

const quietly = async (what: string, fn: () => Promise<unknown>) => {
  if (!dbReady()) return;
  try { await fn(); } catch (err: any) { console.warn(`[Storefront] Could not record rebuild ${what}: ${err?.message}`); }
};

/** A rebuild was asked for (by an admin save, an automatic hook or the "Rebuild now" button). */
export function recordRebuildRequested(by?: string): Promise<void> {
  return quietly('request', () => StorefrontRebuildStatus.updateOne(
    { key: KEY },
    { $set: { lastRequestedAt: new Date(), lastRequestedBy: (by || 'automatic').slice(0, 120) } },
    { upsert: true }
  ));
}

export async function recordRebuildStarted(): Promise<void> {
  await quietly('start', () => StorefrontRebuildStatus.updateOne(
    { key: KEY },
    { $set: { building: true, lastStartedAt: new Date() } },
    { upsert: true }
  ));
}

const alertTo = () => process.env.ADMIN_NOTIFICATION_EMAIL || process.env.LOW_STOCK_ALERT_EMAIL || '';
const from = () => `"${process.env.SMTP_FROM_NAME || 'Solatide Biosciences'}" <${process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com'}>`;
const fmt = (d: Date) => d.toLocaleString('en-AU', { timeZone: process.env.SCHEDULE_TZ || 'Australia/Melbourne' });

async function sendRebuildEmail(kind: 'failed' | 'recovered', status: RebuildStatus): Promise<boolean> {
  const to = alertTo();
  if (!to) {
    console.warn(`[Storefront] ADMIN_NOTIFICATION_EMAIL is not set: no "${kind}" email for the storefront rebuild`);
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { deliverMail } = require('../../queues/producers');
  const subject = kind === 'failed'
    ? 'Action needed: website update failed (changes are not live yet)'
    : 'Website updates are working again';
  const lastOk = status.lastSuccessAt ? fmt(new Date(status.lastSuccessAt)) : 'unknown';
  const html = kind === 'failed'
    ? `<p>The automatic website update (storefront rebuild) <strong>failed</strong> at ${fmt(new Date())} (exit code ${status.lastExitCode ?? '?'}).</p>
       <p>The website is still online and shows the version from the last successful update (${lastOk}). Recent admin changes to products, collections, COAs, FAQs, pages or the homepage are saved, but are <strong>not on the pre-built pages yet</strong>.</p>
       <p>Failed attempts in a row: ${status.consecutiveFailures ?? 1}. The developer can see the details in the server's deploy log (CLIENT_DIR/logs/deploy-*.log). You can retry from Admin → Settings → Store → "Rebuild now".</p>
       <p>You get at most one of these emails per hour while it keeps failing.</p>`
    : `<p>The website update (storefront rebuild) succeeded again at ${fmt(new Date())}. All saved admin changes are now live.</p>`;
  await deliverMail({ from: from(), to, subject, html });
  return true;
}

/** A build finished. `code`: deploy-store.sh exit code (0 ok, 75 busy, anything else failed). */
export async function recordRebuildFinished(code: number, busyCode = 75): Promise<void> {
  if (!dbReady()) return;
  try {
    const now = new Date();
    if (code === busyCode) {
      await StorefrontRebuildStatus.updateOne({ key: KEY }, { $set: { building: false, lastResult: 'busy', lastExitCode: code } }, { upsert: true });
      return;
    }
    const before = (await StorefrontRebuildStatus.findOne({ key: KEY }).lean()) as RebuildStatus | null;
    if (code === 0) {
      await StorefrontRebuildStatus.updateOne(
        { key: KEY },
        { $set: { building: false, lastFinishedAt: now, lastResult: 'success', lastExitCode: 0, lastSuccessAt: now, consecutiveFailures: 0 } },
        { upsert: true }
      );
      // Tell the admins it works again, but only if they were told it failed
      if (before?.lastResult === 'failed' && before.lastAlertAt) {
        await sendRebuildEmail('recovered', { ...before, lastSuccessAt: now }).catch(() => false);
      }
      return;
    }
    const failures = (before?.consecutiveFailures || 0) + 1;
    const alertDue = !before?.lastAlertAt
      || before.lastResult === 'success'
      || now.getTime() - new Date(before.lastAlertAt).getTime() >= ALERT_EVERY_MS;
    await StorefrontRebuildStatus.updateOne(
      { key: KEY },
      { $set: { building: false, lastFinishedAt: now, lastResult: 'failed', lastExitCode: code, lastFailureAt: now, consecutiveFailures: failures } },
      { upsert: true }
    );
    if (alertDue) {
      const sent = await sendRebuildEmail('failed', { ...(before || {}), lastExitCode: code, consecutiveFailures: failures }).catch(() => false);
      if (sent) await StorefrontRebuildStatus.updateOne({ key: KEY }, { $set: { lastAlertAt: now } });
    }
  } catch (err: any) {
    console.warn(`[Storefront] Could not record rebuild result: ${err?.message}`);
  }
}

export async function getRebuildStatus(): Promise<RebuildStatus | null> {
  if (!dbReady()) return null;
  return StorefrontRebuildStatus.findOne({ key: KEY }).select('-_id -__v -key').lean() as any;
}
