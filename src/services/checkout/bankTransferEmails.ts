/**
 * Emails for the bank transfer / PayID checkout:
 * - customer: "Order received — payment required" (sent once, right after the order is placed)
 * - admin: "New order — awaiting payment" (optional, Admin → Settings)
 * There is intentionally no "payment received" email; the existing shipping email follows.
 */
import { deliverMail } from '../../queues/producers';
import { escapeHtml as e, safeUrl } from '../../utils/escapeHtml';
import { instructionsFor, isBankMethod, methodLabel, ORDER_NUMBER_ONLY_WARNING, type BankTransferSettings } from './bankTransfer';

const LOGO = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';
const hdr = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
const aud = (n: unknown) => `$${Number(n || 0).toFixed(2)} AUD`;
const from = () => `"${process.env.SMTP_FROM_NAME || 'Solatide Biosciences'}" <${process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com'}>`;

export function paymentPageUrl(order: any, accessToken: string): string {
  const base = (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
  return `${base}/checkout/payment/${encodeURIComponent(String(order._id))}?accessToken=${encodeURIComponent(accessToken)}`;
}

function itemsTable(order: any): string {
  const rows = (order.lineItems || []).map((li: any) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #eee;width:56px;">${safeUrl(li.productImageUrl) ? `<img src="${safeUrl(li.productImageUrl)}" width="48" height="48" style="border-radius:6px;border:1px solid #eee;object-fit:contain;" alt="" />` : ''}</td>
      <td style="padding:12px;border-bottom:1px solid #eee;font-size:14px;color:#222;">${e(li.title)}${li.variantTitle ? `<br><span style="color:#777;font-size:13px;">${e(li.variantTitle)}</span>` : ''}<br><span style="color:#777;font-size:13px;">Qty: ${e(li.quantity)}</span></td>
      <td style="padding:12px 0;border-bottom:1px solid #eee;text-align:right;font-size:14px;color:#222;vertical-align:top;">${aud(li.subtotal)}</td>
    </tr>`).join('');
  const line = (l: string, v: string, bold = false) => `<tr><td style="padding:4px 0;font-size:${bold ? 16 : 14}px;color:${bold ? '#111' : '#666'};${bold ? 'font-weight:700;' : ''}">${l}</td><td style="padding:4px 0;text-align:right;font-size:${bold ? 16 : 14}px;color:#111;${bold ? 'font-weight:700;' : ''}">${v}</td></tr>`;
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
      ${line('Subtotal', aud(order.subtotal))}
      ${line(e(order.shippingMethodName || 'Shipping'), Number(order.shippingAmount) > 0 ? aud(order.shippingAmount) : 'Free')}
      ${Number(order.taxAmount) > 0 ? line('Including GST', aud(order.taxAmount)) : ''}
      ${line('Total', aud(order.grandTotal), true)}
    </table>`;
}

function paymentBlock(order: any, s: BankTransferSettings): string {
  if (!isBankMethod(order.paymentMethod)) return '';
  const ins = instructionsFor(order.paymentMethod, s, order);
  const rows = ins.fields.map((f) => `
    <tr>
      <td style="padding:7px 0;color:#666;font-size:14px;width:42%;">${e(f.label)}</td>
      <td style="padding:7px 0;color:#111;font-size:15px;font-weight:600;font-family:Menlo,Consolas,monospace;">${e(f.value)}</td>
    </tr>`).join('');
  return `
    <div style="border:1px solid #d7e3f1;border-radius:10px;padding:20px 22px;margin:24px 0;background:#f7fafd;">
      <div style="font-size:16px;font-weight:700;color:#102a5c;margin-bottom:10px;">${e(ins.label)}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      ${ins.notes.map((n) => `<p style="margin:14px 0 0;font-size:13px;color:#555;line-height:1.5;">${e(n)}</p>`).join('')}
    </div>`;
}

function warningBlock(): string {
  return `
    <div style="border:1px solid #f3c98b;background:#fff8ec;border-radius:10px;padding:16px 20px;margin:0 0 24px;">
      <div style="font-size:14px;font-weight:800;color:#9a5b00;letter-spacing:.3px;margin-bottom:8px;">IMPORTANT — ORDER NUMBER ONLY</div>
      ${ORDER_NUMBER_ONLY_WARNING.map((t) => `<p style="margin:0 0 6px;font-size:13px;color:#6b4300;line-height:1.5;">${e(t)}</p>`).join('')}
    </div>`;
}

function layout(title: string, body: string, orderNumber: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${e(title)}</title></head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:20px 0;">
      <div style="padding:16px 32px;"><img src="${LOGO}" alt="Solatide Biosciences" style="height:56px;" /><span style="float:right;color:#777;font-size:13px;padding-top:18px;">ORDER #${e(orderNumber)}</span></div>
      <div style="background:#fff;padding:32px;">${body}</div>
      <p style="text-align:center;color:#999;font-size:12px;margin:16px 0;">Solatide Biosciences · Australia</p>
    </div>
  </body></html>`;
}

/** Customer: "Order received — payment required" with the selected method only. */
export async function sendAwaitingPaymentEmail(order: any, s: BankTransferSettings, accessToken: string): Promise<void> {
  const to = order.customer?.email || order.customerEmail;
  if (!to) return;
  const url = paymentPageUrl(order, accessToken);
  const body = `
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#111;">Order received — payment required</h2>
    <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.55;">Hi ${e(order.customer?.firstName || '')}, thanks for your order. Please complete your payment using the details below. Your order will be processed once payment has been received and matched to your order.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr><td style="padding:6px 0;color:#666;font-size:14px;">Order number</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:15px;color:#111;">#${e(order.orderNumber)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;font-size:14px;">Amount to pay</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:15px;color:#111;">${aud(order.grandTotal)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;font-size:14px;">Payment reference</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:15px;color:#111;">${e(order.orderNumber)}</td></tr>
    </table>
    ${paymentBlock(order, s)}
    ${warningBlock()}
    <p style="margin:0 0 28px;"><a href="${e(url)}" style="background:#102a5c;color:#fff;text-decoration:none;padding:13px 22px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block;">View payment details</a></p>
    <div style="font-size:16px;font-weight:600;color:#111;border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:4px;">Order summary</div>
    ${itemsTable(order)}
    <div style="margin-top:24px;font-size:14px;color:#555;line-height:1.6;">
      <strong style="color:#111;">Shipping to</strong><br>
      ${e(order.shippingAddressObj?.name)}<br>${e(order.shippingAddressObj?.street1)}${order.shippingAddressObj?.street2 ? `, ${e(order.shippingAddressObj.street2)}` : ''}<br>
      ${e(order.shippingAddressObj?.city)} ${e(order.shippingAddressObj?.state)} ${e(order.shippingAddressObj?.zip)}<br>${e(order.shippingAddressObj?.country)}
    </div>`;
  await deliverMail({
    from: from(), to,
    subject: hdr(`Order #${order.orderNumber} received — payment required`),
    html: layout('Order received — payment required', body, order.orderNumber),
  });
}

/** Admin: a new order is waiting for payment (check the bank for the reference). */
export async function sendAdminAwaitingPaymentEmail(order: any): Promise<void> {
  const to = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.LOW_STOCK_ALERT_EMAIL;
  if (!to) {
    console.warn(`[Checkout] ADMIN_NOTIFICATION_EMAIL is not set: no admin email for order ${order.orderNumber}`);
    return;
  }
  const adminUrl = (process.env.ADMIN_URL || 'https://hub.solatidebiosciences.com.au').replace(/\/$/, '');
  const method = methodLabel(order.paymentMethod);
  const body = `
    <div style="display:inline-block;background:#fff3d6;color:#8a5a00;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;margin-bottom:12px;">AWAITING PAYMENT • ${e(method)}</div>
    <h2 style="margin:0 0 6px;font-size:20px;color:#111;">New order #${e(order.orderNumber)} — ${aud(order.grandTotal)}</h2>
    <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.55;">Check the bank for a payment with reference <strong>${e(order.orderNumber)}</strong>, then mark the order as paid in the admin. No email is sent to the customer when you do.</p>
    <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.6;"><strong style="color:#111;">${e(order.customerName)}</strong><br>${e(order.customer?.email || order.customerEmail)} · ${e(order.customer?.phone)}<br>${e(order.shippingAddressObj?.city)} ${e(order.shippingAddressObj?.state)} ${e(order.shippingAddressObj?.country)}</p>
    ${itemsTable(order)}
    <p style="margin:24px 0 0;"><a href="${e(`${adminUrl}/admin/orders/${order._id}`)}" style="background:#102a5c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block;">Open order</a></p>`;
  await deliverMail({
    from: from(), to,
    subject: hdr(`New order #${order.orderNumber} — awaiting ${method} payment (${aud(order.grandTotal)})`),
    html: layout('New order — awaiting payment', body, order.orderNumber),
  });
}
