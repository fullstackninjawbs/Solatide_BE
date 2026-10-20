import Product from '../models/product.model';
import Order from '../models/order.model';
import { deliverMail } from '../queues/producers';
import { escapeHtml as e } from '../utils/escapeHtml';
import { LowStockCrossing } from './orders/inventory';
import { globalLowStockThreshold, lowStockThresholdFor } from '../utils/lowStock';

export interface LowStockRow {
  productId: string;
  productName: string;
  variantName?: string;
  sku?: string;
  stock: number;
  threshold: number;
  publishStatus?: string;
  continueSelling: boolean;
  /** This order just took it to/below the threshold */
  justDropped: boolean;
}

const thresholdOf = (p: any): number => lowStockThresholdFor(p);

/**
 * Every product/variant currently at or below its low-stock threshold (archived products
 * excluded). Products with variants are listed per variant; others by their own stock.
 */
export async function getLowStockRows(justDropped: LowStockCrossing[] = []): Promise<LowStockRow[]> {
  const products: any[] = await Product.find({ publishStatus: { $ne: 'archived' } })
    .select('name sku stockQuantity lowStockThreshold publishStatus variants inventoryPolicy continueSellingWhenOutOfStock')
    .lean();
  const dropped = new Set(justDropped.map((c) => `${c.productId}:${c.variantId ?? ''}`));
  const rows: LowStockRow[] = [];
  for (const p of products) {
    const threshold = thresholdOf(p);
    const productContinues = p.inventoryPolicy === 'continue' || p.continueSellingWhenOutOfStock === true;
    const variants: any[] = Array.isArray(p.variants) ? p.variants : [];
    if (variants.length) {
      for (const v of variants) {
        const stock = Number(v.stockQty ?? 0);
        if (stock > threshold) continue;
        rows.push({
          productId: String(p._id), productName: p.name,
          variantName: variants.length > 1 ? (v.name || v.title || v.option1 || undefined) : undefined,
          sku: v.sku || p.sku, stock, threshold, publishStatus: p.publishStatus,
          continueSelling: productContinues || v.inventoryPolicy === 'continue' || v.continueSellingWhenOutOfStock === true,
          justDropped: dropped.has(`${p._id}:${v._id}`),
        });
      }
    } else {
      const stock = Number(p.stockQuantity ?? 0);
      if (stock > threshold) continue;
      rows.push({
        productId: String(p._id), productName: p.name, sku: p.sku, stock, threshold, publishStatus: p.publishStatus,
        continueSelling: productContinues, justDropped: dropped.has(`${p._id}:`),
      });
    }
  }
  // Just-dropped first, then lowest stock first, then name
  return rows.sort((a, b) => Number(b.justDropped) - Number(a.justDropped) || a.stock - b.stock || a.productName.localeCompare(b.productName));
}

const adminRecipient = (): string =>
  process.env.LOW_STOCK_ALERT_EMAIL || process.env.ADMIN_NOTIFICATION_EMAIL || 'fullstackninja.wbs@gmail.com';

/**
 * Admin email when an order takes products to/below their low-stock threshold or sells them out:
 * the items that just dropped (highlighted) plus a table of every item currently at/below its threshold.
 */
export async function sendLowStockAlertEmail(crossings: LowStockCrossing[], context?: { orderNumber?: string }): Promise<boolean> {
  if (!crossings.length) return false;
  const to = adminRecipient();
  if (!to) return false;

  const rows = await getLowStockRows(crossings);
  const adminUrl = (process.env.ADMIN_URL || 'https://hub.solatidebiosciences.com.au').replace(/\/$/, '');
  const logo = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';
  const label = (c: { productName?: string; variantName?: string }) => `${c.productName || 'Product'}${c.variantName ? ` — ${c.variantName}` : ''}`;

  const soldOut = crossings.filter((c) => c.soldOut || c.after <= 0);
  const subject = crossings.length === 1
    ? (soldOut.length ? `Sold out: ${label(crossings[0])} (0 left)` : `Low stock: ${label(crossings[0])} (${crossings[0].after} left)`)
    : soldOut.length
      ? `Stock alert: ${soldOut.length} sold out${crossings.length > soldOut.length ? `, ${crossings.length - soldOut.length} low` : ''}`
      : `Low stock: ${crossings.length} products at or below their threshold`;
  const heading = soldOut.length === crossings.length ? 'Sold out alert' : soldOut.length ? 'Sold out &amp; low stock alert' : 'Low stock alert';

  const status = (r: LowStockRow) =>
    r.stock <= 0
      ? (r.continueSelling ? '<span style="color:#b45309;font-weight:600;">0 — still selling (back order)</span>' : '<span style="color:#dc2626;font-weight:700;">Sold out</span>')
      : '<span style="color:#b45309;font-weight:600;">Low</span>';

  const rowHtml = rows.map((r) => `
    <tr style="${r.justDropped ? 'background:#fff7ed;' : ''}">
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#1e293b;">
        ${r.justDropped ? '<span style="display:inline-block;background:#f97316;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;margin-right:6px;">JUST DROPPED</span>' : ''}
        <strong>${e(r.productName)}</strong>${r.variantName ? `<br><span style="color:#64748b;font-size:13px;">${e(r.variantName)}</span>` : ''}
        ${r.publishStatus && r.publishStatus !== 'active' ? `<br><span style="color:#94a3b8;font-size:12px;">(${e(r.publishStatus)})</span>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#64748b;">${e(r.sku || '—')}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:700;color:${r.stock <= 0 ? '#dc2626' : '#1e293b'};text-align:center;">${r.stock}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;">${status(r)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;"><a href="${e(`${adminUrl}/admin/products/edit/${encodeURIComponent(r.productId)}`)}" style="color:#0079CE;text-decoration:none;font-weight:600;">Edit</a></td>
    </tr>`).join('');

  const droppedList = crossings.map((c) => `<li style="margin:4px 0;"><strong>${e(label(c))}</strong>: ${c.before} → <strong>${c.after}</strong> left${c.soldOut || c.after <= 0 ? ' <span style="color:#dc2626;font-weight:700;">— SOLD OUT</span>' : ''}</li>`).join('');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:680px;margin:0 auto;padding:24px;">
    <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0;">
      <img src="${logo}" alt="Solatide Biosciences" style="height:40px;margin-bottom:18px;" />
      <h2 style="margin:0 0 6px;color:#0f2a4a;font-size:20px;">${heading}</h2>
      <p style="margin:0 0 14px;color:#475569;font-size:14px;">
        ${context?.orderNumber ? `Order <strong>${e(context.orderNumber)}</strong> took` : 'A recent order took'} ${crossings.length === 1 ? 'this item' : 'these items'} ${soldOut.length === crossings.length ? 'to 0 (sold out)' : soldOut.length ? 'to or below the low-stock threshold, or sold them out' : 'to or below the low-stock threshold'}:
      </p>
      <ul style="margin:0 0 20px;padding-left:20px;color:#1e293b;font-size:14px;">${droppedList}</ul>
      <h3 style="margin:0 0 8px;color:#0f2a4a;font-size:15px;">All items at or below their threshold (${rows.length})</h3>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;">Product</th>
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;">SKU</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase;">Stock</th>
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;">Status</th>
          <th style="padding:10px 12px;"></th>
        </tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;">Threshold: ${globalLowStockThreshold()} (store setting), or a product's own low stock threshold where it was changed. You receive an alert when an order takes an item from above its threshold to at or below it, and again when an order sells the last one.</p>
    </div>
  </div></body></html>`;

  const fromName = process.env.SMTP_FROM_NAME || 'Solatide Biosciences';
  const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com';
  await deliverMail({ from: `"${fromName}" <${fromEmail}>`, to, subject, html });
  console.log(`[Low Stock] Alert ${subject.length > 80 ? subject.slice(0, 80) + '…' : subject} → ${to} (${rows.length} item(s) listed)`);
  return true;
}

/**
 * Send the low-stock alert recorded on an order (order.lowStockAlert.items) at most once:
 * the send is claimed atomically (lowStockAlert.sentAt), so the admin manual-order path and the
 * paid-order side effects (and their retries) can both call this safely. Released on failure so
 * a retry can send it.
 */
export async function sendOrderLowStockAlert(orderId: unknown): Promise<boolean> {
  const claimed: any = await Order.findOneAndUpdate(
    { _id: orderId, 'lowStockAlert.items.0': { $exists: true }, 'lowStockAlert.sentAt': null },
    { $set: { 'lowStockAlert.sentAt': new Date() } },
    { new: true }
  ).select('lowStockAlert orderNumber').lean();
  if (!claimed) return false;
  try {
    return await sendLowStockAlertEmail(claimed.lowStockAlert.items, { orderNumber: claimed.orderNumber });
  } catch (err) {
    await Order.updateOne({ _id: orderId }, { $set: { 'lowStockAlert.sentAt': null } }).catch(() => undefined);
    throw err;
  }
}
