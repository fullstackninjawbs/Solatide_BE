/**
 * Duplicate shipping label alerts.
 *
 * Every Starshipit label is charged to the carrier account (MyPost Business), so a second label for
 * the same order is money lost unless the unused one is refunded. Our own code never buys a second
 * label, but labels can still be created inside Starshipit (automation, "Redo shipping", printing
 * an order twice). This module only DETECTS that and tells the team, so the extra label can be
 * refunded quickly. It never buys, voids or changes a label, and never changes the order's
 * tracking or status.
 *
 * Signals:
 *  - second_tracking          Starshipit reported a different tracking number for an order that
 *                             already had one (webhook / daily check)
 *  - second_starshipit_order  Starshipit has more than one order for the same order number
 *  - label_exists_elsewhere   MyPost refused our label request because a label already existed
 *                             (error 51015 "generated via a different service")
 *
 * Each new piece of evidence is recorded once on the order (labelDuplicate) and alerted once.
 * When an admin marks it resolved, the same evidence never re-opens it; new evidence does.
 */
import Order from '../../models/order.model';
import { deliverMail } from '../../queues/producers';
import { escapeHtml as e } from '../../utils/escapeHtml';

export type DuplicateReason = 'second_tracking' | 'second_starshipit_order' | 'label_exists_elsewhere';

export interface DuplicateEvidence {
  reason: DuplicateReason;
  trackingNumbers?: string[];
  starshipitOrderIds?: string[];
}

export interface LabelDuplicateRecord {
  detectedAt?: Date;
  lastDetectedAt?: Date;
  reasons?: string[];
  trackingNumbers?: string[];
  starshipitOrderIds?: string[];
  alertedAt?: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

export const DUPLICATE_REASON_TEXT: Record<DuplicateReason, string> = {
  second_tracking: 'Starshipit reported more than one tracking number for this order',
  second_starshipit_order: 'Starshipit has more than one order for this order number',
  label_exists_elsewhere: 'Australia Post (MyPost) refused a new label because one already existed for this order',
};

/** MyPost error 51015: "These labels have been generated via a different service…" — a label already exists. */
export function isLabelExistsElsewhereError(message: unknown): boolean {
  return /\b51015\b|generated via a different service/i.test(String(message ?? ''));
}

const clean = (list: unknown[] | undefined): string[] =>
  Array.from(new Set((list || []).map((v) => String(v ?? '').trim()).filter(Boolean)));

/**
 * Adds evidence to an order's existing record (pure).
 * isNew = the reason, a tracking number or a Starshipit order id wasn't recorded before.
 * New evidence re-opens a resolved record; repeated evidence leaves it as it was.
 */
export function mergeDuplicateEvidence(
  existing: LabelDuplicateRecord | null | undefined,
  evidence: DuplicateEvidence,
  now: Date = new Date(),
): { next: LabelDuplicateRecord; isNew: boolean } {
  const prev = existing || {};
  const reasons = clean(prev.reasons);
  const trackingNumbers = clean(prev.trackingNumbers);
  const starshipitOrderIds = clean(prev.starshipitOrderIds);

  let isNew = !reasons.includes(evidence.reason);
  if (isNew) reasons.push(evidence.reason);
  for (const t of clean(evidence.trackingNumbers)) {
    if (!trackingNumbers.includes(t)) { trackingNumbers.push(t); isNew = true; }
  }
  for (const id of clean(evidence.starshipitOrderIds)) {
    if (!starshipitOrderIds.includes(id)) { starshipitOrderIds.push(id); isNew = true; }
  }

  const next: LabelDuplicateRecord = {
    detectedAt: prev.detectedAt || now,
    lastDetectedAt: now,
    reasons,
    trackingNumbers,
    starshipitOrderIds,
    alertedAt: prev.alertedAt,
    resolvedAt: isNew ? undefined : prev.resolvedAt,
    resolvedBy: isNew ? undefined : prev.resolvedBy,
  };
  return { next, isNew };
}

/** Our order fields the shipped-list check compares against. */
export interface OrderForDuplicateCheck {
  orderNumber?: string;
  starshipitOrderId?: string;
  trackingNumber?: string;
  trackingSource?: string;
}

/**
 * From Starshipit's shipped list, the evidence for each of OUR orders (pure).
 *  - more than one Starshipit order id for the order number (including the id we saved)
 *  - more than one tracking number (including ours, unless it was entered manually — a manual
 *    number can legitimately differ, e.g. a label made directly in Australia Post)
 * Archived / cancelled Starshipit orders (label voided) are ignored.
 */
export function findShippedListDuplicates(
  shipped: any[],
  ordersByNumber: Map<string, OrderForDuplicateCheck>,
): Map<string, DuplicateEvidence[]> {
  const groups = new Map<string, any[]>();
  for (const s of shipped || []) {
    const num = String(s?.order_number ?? '').trim();
    if (!num || /^(archived|cancelled|canceled|deleted)$/i.test(String(s?.status || '').trim())) continue;
    if (!groups.has(num)) groups.set(num, []);
    groups.get(num)!.push(s);
  }

  const out = new Map<string, DuplicateEvidence[]>();
  for (const [num, list] of groups) {
    const order = ordersByNumber.get(num);
    if (!order) continue; // not one of our orders
    const ids = clean([...list.map((s) => s?.order_id), order.starshipitOrderId]);
    const trks = clean([
      ...list.map((s) => s?.tracking_number),
      order.trackingSource === 'manual' ? '' : order.trackingNumber,
    ]);
    const evidence: DuplicateEvidence[] = [];
    if (ids.length > 1) evidence.push({ reason: 'second_starshipit_order', starshipitOrderIds: ids, trackingNumbers: trks });
    if (trks.length > 1) evidence.push({ reason: 'second_tracking', trackingNumbers: trks, starshipitOrderIds: ids });
    if (evidence.length) out.set(num, evidence);
  }
  return out;
}

const adminUrl = () => (process.env.ADMIN_URL || 'https://hub.solatidebiosciences.com.au').split(',')[0].trim().replace(/\/$/, '');
const alertTo = () => process.env.ADMIN_NOTIFICATION_EMAIL || process.env.LOW_STOCK_ALERT_EMAIL || '';
const from = () => `"${process.env.SMTP_FROM_NAME || 'Solatide Biosciences'}" <${process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com'}>`;
const hdr = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);

type AlertOrder = { _id: unknown; orderNumber?: string; labelDuplicate?: LabelDuplicateRecord };

function orderBlock(o: AlertOrder): string {
  const d = o.labelDuplicate || {};
  const reasons = (d.reasons || []).map((r) => DUPLICATE_REASON_TEXT[r as DuplicateReason] || r);
  const row = (label: string, value: string) => value
    ? `<tr><td style="padding:4px 0;color:#666;font-size:13px;vertical-align:top;width:170px;">${e(label)}</td><td style="padding:4px 0;font-size:13px;color:#111;">${e(value)}</td></tr>`
    : '';
  return `
    <div style="border:1px solid #f1c4c4;background:#fff7f7;border-radius:8px;padding:14px 16px;margin:0 0 14px;">
      <div style="font-size:15px;font-weight:700;color:#111;margin-bottom:6px;">Order #${e(o.orderNumber || '')}</div>
      <ul style="margin:0 0 8px 18px;padding:0;color:#7a1f1f;font-size:13px;line-height:1.5;">${reasons.map((r) => `<li>${e(r)}</li>`).join('')}</ul>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${row('Tracking numbers', (d.trackingNumbers || []).join(', '))}
        ${row('Starshipit order IDs', (d.starshipitOrderIds || []).join(', '))}
      </table>
      <p style="margin:10px 0 0;"><a href="${e(`${adminUrl()}/admin/orders/${o._id}`)}" style="background:#102a5c;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13px;font-weight:600;display:inline-block;">Open order</a></p>
    </div>`;
}

/** One email to the team for one or more flagged orders. Returns true when it was queued. */
export async function sendLabelDuplicateEmail(orders: AlertOrder[], context: 'live' | 'daily' = 'live'): Promise<boolean> {
  if (!orders.length) return false;
  const to = alertTo();
  if (!to) {
    console.warn(`[LabelDuplicate] ADMIN_NOTIFICATION_EMAIL is not set: no alert email for ${orders.map((o) => o.orderNumber).join(', ')}`);
    return false;
  }
  const subject = orders.length === 1
    ? `Possible duplicate shipping label — order #${orders[0].orderNumber}`
    : `Possible duplicate shipping labels — ${orders.length} orders`;
  const body = `
    <div style="display:inline-block;background:#fde8e8;color:#9b1c1c;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;margin-bottom:12px;">POSSIBLE DUPLICATE LABEL${orders.length > 1 ? 'S' : ''}</div>
    <h2 style="margin:0 0 8px;font-size:20px;color:#111;">${e(context === 'daily' ? 'Daily Starshipit check found possible duplicate labels' : 'A possible duplicate shipping label was detected')}</h2>
    <p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.55;">Each label is charged to your MyPost Business account. Please check ${orders.length === 1 ? 'this order' : 'these orders'}:</p>
    <ol style="margin:0 0 18px 18px;padding:0;color:#555;font-size:14px;line-height:1.6;">
      <li>Keep the label that is on the parcel.</li>
      <li>In <strong>MyPost Business</strong>, request a refund for any unused label (search by tracking number). Unused labels are refundable for a limited time.</li>
      <li>In Starshipit, archive any duplicate order. Use <strong>Reprint label</strong> (free) — never <strong>Redo shipping</strong>.</li>
      <li>Then click <strong>Mark as resolved</strong> on the order in the admin.</li>
    </ol>
    ${orders.map(orderBlock).join('')}
    <p style="margin:18px 0 0;color:#888;font-size:12px;line-height:1.5;">Nothing was changed on the order or in Starshipit — this is an alert only. If one of the labels was already voided or refunded, just mark it as resolved.</p>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${e(subject)}</title></head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:20px 0;"><div style="background:#fff;padding:28px 32px;">${body}</div>
    <p style="text-align:center;color:#999;font-size:12px;margin:16px 0;">Solatide Biosciences · Admin alert</p></div>
  </body></html>`;
  await deliverMail({ from: from(), to, subject: hdr(subject), html });
  return true;
}

/**
 * Records evidence on the order and (by default) emails the team when it is new.
 * Never throws — a failure here must never affect labels, webhooks or tracking.
 * Returns the order when new evidence was recorded (so a batch can alert once for many).
 */
export async function recordLabelDuplicate(
  orderId: unknown,
  evidence: DuplicateEvidence,
  opts: { notify?: boolean } = {},
): Promise<AlertOrder | null> {
  try {
    const order: any = await Order.findById(orderId).select('orderNumber labelDuplicate').lean();
    if (!order) return null;
    const { next, isNew } = mergeDuplicateEvidence(order.labelDuplicate, evidence);
    if (!isNew) {
      await Order.updateOne({ _id: order._id }, { $set: { 'labelDuplicate.lastDetectedAt': next.lastDetectedAt } });
      return null;
    }
    await Order.updateOne({ _id: order._id }, { $set: { labelDuplicate: next } });
    console.warn(`[LabelDuplicate] order ${order.orderNumber}: ${evidence.reason} (tracking: ${(next.trackingNumbers || []).join(', ') || '-'}; Starshipit ids: ${(next.starshipitOrderIds || []).join(', ') || '-'})`);
    const flagged: AlertOrder = { _id: order._id, orderNumber: order.orderNumber, labelDuplicate: next };
    if (opts.notify !== false) await markAlerted([flagged], 'live');
    return flagged;
  } catch (err: any) {
    console.error(`[LabelDuplicate] could not record ${evidence?.reason} for order ${String(orderId)}: ${err?.message}`);
    return null;
  }
}

/** Emails the team about these orders and stamps alertedAt. Never throws. */
export async function markAlerted(orders: AlertOrder[], context: 'live' | 'daily'): Promise<void> {
  if (!orders.length) return;
  try {
    const sent = await sendLabelDuplicateEmail(orders, context);
    if (sent) {
      await Order.updateMany({ _id: { $in: orders.map((o) => o._id) } }, { $set: { 'labelDuplicate.alertedAt': new Date() } });
    }
  } catch (err: any) {
    console.error(`[LabelDuplicate] alert email failed: ${err?.message}`);
  }
}
