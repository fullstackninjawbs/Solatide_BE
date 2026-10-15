/**
 * Scheduled maintenance jobs (run by the 'maintenance' queue worker on a cron schedule).
 * Every job is OFF unless its schedule env variable is set — see .env.example:
 *
 *   STARSHIPIT_TRACKING_CRON     e.g. "* /30 * * * *" (no space)  refresh tracking for open shipments
 *   TAGADA_SYNC_CRON             e.g. "0 * * * *"                 sync products from Tagada
 *   BACKUP_CRON                  e.g. "0 3 * * *"                 mongodump (read-only URI) to disk
 *   ABANDONED_REMINDER_CRON      e.g. "* /15 * * * *" (no space)  one reminder per unpaid checkout
 *
 * None of these jobs deletes anything.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import Order from '../../models/order.model';
import { starshipitService } from '../shipping/starshipit.service';
import { applyStarshipitTrackingUpdate } from '../shipping/starshipitTracking';
import { syncAllTagadaProducts } from '../tagadaProductSync.service';
import { deliverMail } from '../../queues/producers';
import { escapeHtml as e } from '../../utils/escapeHtml';

/** Refresh Starshipit tracking for recent paid orders that are not delivered yet (same logic as the webhook). */
export async function refreshStarshipitTracking(): Promise<{ checked: number; updated: number; shipped: number; errors: number }> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const orders = await Order.find({
    starshipitOrderId: { $exists: true, $nin: [null, ''] },
    paymentStatus: { $in: ['paid', 'partially_refunded'] },
    isDeleted: { $ne: true },
    createdAt: { $gte: since },
    shipmentStatus: { $not: /delivered/i },
  }).sort({ updatedAt: 1 }).limit(50);

  let updated = 0, shipped = 0, errors = 0;
  for (const order of orders) {
    try {
      const d = await starshipitService.getShipmentDetails(String(order.starshipitOrderId));
      const r = await applyStarshipitTrackingUpdate(order, {
        tracking_number: d.trackingNumber,
        tracking_status: d.shipmentStatus,
        carrier: d.trackingCarrier,
        label_url: d.labelUrl,
      });
      if (r.changed) updated++;
      if (r.newlyShipped) shipped++;
    } catch (err: any) {
      errors++;
      console.warn(`[Scheduled] tracking refresh failed for order ${order.orderNumber ?? order._id}: ${err?.message}`);
    }
  }
  return { checked: orders.length, updated, shipped, errors };
}

/** Pull products from Tagada (same as Admin → Tagada Sync, recorded as a 'scheduled' sync). */
export async function scheduledTagadaSync(): Promise<unknown> {
  return syncAllTagadaProducts(undefined, 'scheduled');
}

/**
 * Database backup with mongodump to a local archive. Uses BACKUP_MONGO_URI — create a
 * READ-ONLY database user for it. Never deletes old archives (clean up manually).
 */
export async function runDatabaseBackup(): Promise<{ file: string; bytes: number }> {
  const uri = process.env.BACKUP_MONGO_URI;
  if (!uri) throw new Error('BACKUP_MONGO_URI is not set');
  const dir = process.env.BACKUP_DIR || '/var/backups/solatide-mongo';
  const bin = process.env.MONGODUMP_PATH || 'mongodump';
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `solatide-${stamp}.archive.gz`);
  await new Promise<void>((resolve, reject) => {
    // The URI is passed as an argument (never logged). stdio is ignored to keep credentials out of logs.
    const child = spawn(bin, [`--uri=${uri}`, `--archive=${file}`, '--gzip', '--readPreference=secondaryPreferred'], { stdio: 'ignore' });
    child.on('error', (err) => reject(new Error(`mongodump could not start (${err.message}); set MONGODUMP_PATH`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mongodump exited with code ${code}`))));
  });
  const bytes = fs.statSync(file).size;
  console.log(`[Scheduled] backup written: ${file} (${Math.round(bytes / 1024)} KB)`);
  return { file, bytes };
}

/**
 * One reminder email per unpaid checkout, ABANDONED_REMINDER_DELAY_HOURS (default 2) after it
 * was started and within 48 h. Skipped when the same email has since paid for an order.
 */
export async function sendAbandonedCheckoutReminders(): Promise<{ candidates: number; sent: number; skipped: number }> {
  const delayH = Math.max(1, Number(process.env.ABANDONED_REMINDER_DELAY_HOURS) || 2);
  const now = Date.now();
  const candidates = await Order.find({
    paymentStatus: 'pending',
    isDeleted: { $ne: true },
    abandonedReminderSentAt: null,
    customerEmail: { $exists: true, $nin: [null, ''] },
    createdAt: { $gte: new Date(now - 48 * 3600 * 1000), $lte: new Date(now - delayH * 3600 * 1000) },
  }).limit(50);

  const store = (process.env.CLIENT_URL || 'https://solatidebiosciences.com.au').replace(/\/$/, '');
  let sent = 0, skipped = 0;
  for (const order of candidates) {
    const email = String(order.customerEmail).trim().toLowerCase();
    // Completed another order since? Then no reminder.
    const paidSince = await Order.exists({
      customerEmail: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      paymentStatus: { $in: ['paid', 'partially_refunded'] },
      createdAt: { $gte: order.createdAt },
    });
    // Claim first so a reminder is never sent twice (also marks skipped ones as handled)
    const claim = await Order.updateOne({ _id: order._id, abandonedReminderSentAt: null }, { $set: { abandonedReminderSentAt: new Date() } });
    if (claim.modifiedCount !== 1) continue;
    if (paidSince) { skipped++; continue; }

    const items = (order.lineItems || []).slice(0, 10)
      .map((li: any) => `<li style="margin:4px 0">${e(li.title)}${li.quantity > 1 ? ` × ${Number(li.quantity)}` : ''}</li>`).join('');
    await deliverMail({
      from: `"${process.env.SMTP_FROM_NAME || 'Solatide Biosciences'}" <${process.env.SMTP_FROM_EMAIL}>`,
      to: email,
      subject: 'You left something in your checkout',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
        <h2 style="color:#1a3a6b">Your checkout is waiting</h2>
        <p>You started a checkout at Solatide Biosciences but didn't complete payment.</p>
        ${items ? `<ul style="padding-left:18px">${items}</ul>` : ''}
        <p><a href="${store}/collections/all" style="display:inline-block;background:#1F54A1;color:#fff;padding:11px 22px;border-radius:40px;text-decoration:none">Return to the store</a></p>
        <p style="font-size:12px;color:#64748b">All products are for in-vitro laboratory research use only. You're receiving this one-time reminder because you started a checkout with this email address.</p>
      </div>`,
    });
    sent++;
  }
  return { candidates: candidates.length, sent, skipped };
}
