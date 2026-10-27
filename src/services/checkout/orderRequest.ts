/**
 * orderRequest.ts — the "Order Request" checkout mode (Admin → Settings → Checkout mode; before a
 * mode is saved, ORDER_REQUEST_CHECKOUT=true still selects it). "Check out" shows an order-request
 * form: the customer's details + cart are emailed to the admin (who creates the order in Admin and
 * arranges payment) and the customer gets a confirmation.
 * No order is created, no stock changes, no payment details are shown.
 */
import crypto from 'crypto';
import { deliverMail } from '../../queues/producers';
import { escapeHtml as e } from '../../utils/escapeHtml';

/**
 * Shipping shown on the order-request page (AUD, incl. GST). Unset → "To be confirmed" (sent with
 * the payment instructions).
 *   ORDER_REQUEST_SHIPPING_AU=15  ORDER_REQUEST_SHIPPING_INTL=45  ORDER_REQUEST_FREE_SHIPPING_FROM_AU=300
 */
const envMoney = (k: string): number | null => {
  const raw = (process.env[k] || '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};
export function orderRequestShippingConfig() {
  return { AU: envMoney('ORDER_REQUEST_SHIPPING_AU'), international: envMoney('ORDER_REQUEST_SHIPPING_INTL'), freeFromAU: envMoney('ORDER_REQUEST_FREE_SHIPPING_FROM_AU') };
}
/** Shipping for a country + subtotal; null = to be confirmed. */
export function orderRequestShippingFor(country: string, subtotal: number): number | null {
  const c = orderRequestShippingConfig();
  if (String(country).toUpperCase() === 'AU') {
    if (c.freeFromAU != null && c.freeFromAU > 0 && subtotal >= c.freeFromAU) return 0;
    return c.AU;
  }
  return c.international;
}

export const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

export class OrderRequestInputError extends Error { statusCode = 400; }

const clean = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function validateOrderRequestInput(body: any) {
  const c = body?.customer || {};
  const a = body?.shippingAddress || {};
  const customer = { email: clean(c.email, 254).toLowerCase(), firstName: clean(c.firstName, 60), lastName: clean(c.lastName, 60), phone: clean(c.phone, 30) };
  const address = {
    company: clean(a.company, 120), street1: clean(a.street1, 120), street2: clean(a.street2, 120),
    city: clean(a.city, 80), state: clean(a.state, 80), zip: clean(a.zip, 20), country: clean(a.country, 2).toUpperCase(),
  };
  const notes = clean(body?.notes, 1000);
  const errors: string[] = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email)) errors.push('a valid email address');
  if (!customer.firstName) errors.push('first name');
  if (!customer.lastName) errors.push('last name');
  if (!/^\+?[0-9 ()-]{6,30}$/.test(customer.phone) || customer.phone.replace(/\D/g, '').length < 6) errors.push('a valid phone number');
  if (!/^[A-Z]{2}$/.test(address.country)) errors.push('country');
  if (!address.street1) errors.push('street address');
  if (!address.city) errors.push(address.country === 'AU' ? 'suburb / city' : 'city');
  if (address.country === 'AU') {
    if (!AU_STATES.includes(address.state.toUpperCase())) errors.push('state');
    else address.state = address.state.toUpperCase();
    if (!/^\d{4}$/.test(address.zip)) errors.push('a 4-digit postcode');
  } else if (!address.zip) {
    errors.push('postal code');
  }
  if (errors.length) throw new OrderRequestInputError(`Please enter ${errors.join(', ')}.`);
  return { customer, address, notes };
}

/** Short, readable reference: REQ-7K4M2Q (no 0/O/1/I). */
export function newRequestNumber(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  return `REQ-${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

const LOGO = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';
const hdr = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
const aud = (n: unknown) => `$${Number(n || 0).toFixed(2)} AUD`;
const from = () => `"${process.env.SMTP_FROM_NAME || 'Solatide Biosciences'}" <${process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com'}>`;

function itemsTable(req: any): string {
  const rows = req.items.map((i: any) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#222;">${e(i.title)}${i.variantTitle ? ` <span style="color:#777;">· ${e(i.variantTitle)}</span>` : ''}${i.sku ? `<br><span style="color:#999;font-size:12px;">SKU ${e(i.sku)}</span>` : ''}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:14px;color:#222;text-align:center;">× ${e(i.quantity)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#222;text-align:right;">${aud(i.subtotal)}</td>
    </tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}
    <tr><td colspan="2" style="padding:10px 0 4px;font-size:14px;color:#666;">Subtotal</td><td style="padding:10px 0 4px;text-align:right;font-size:14px;color:#222;">${aud(req.subtotal)}</td></tr>
    ${Number(req.discountAmount) > 0 ? `<tr><td colspan="2" style="padding:4px 0;font-size:14px;color:#666;">Discount${req.discountCode ? ` (${e(req.discountCode)})` : ''}</td><td style="padding:4px 0;text-align:right;font-size:14px;color:#222;">−${aud(req.discountAmount)}</td></tr>` : ''}
    <tr><td colspan="2" style="padding:4px 0;font-size:14px;color:#666;">Shipping</td><td style="padding:4px 0;text-align:right;font-size:14px;color:#222;">${req.shippingAmount == null ? 'To be confirmed' : Number(req.shippingAmount) === 0 ? 'Free' : aud(req.shippingAmount)}</td></tr>
    <tr><td colspan="2" style="padding:10px 0;font-size:15px;font-weight:700;color:#111;">Total${req.shippingAmount == null ? ' (excl. shipping)' : ''}</td><td style="padding:10px 0;text-align:right;font-size:15px;font-weight:700;color:#111;">${aud(req.total ?? req.subtotal)}</td></tr></table>`;
}

function layout(title: string, body: string, ref: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${e(title)}</title></head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:20px 0;">
      <div style="padding:16px 32px;"><img src="${LOGO}" alt="Solatide Biosciences" style="height:56px;" /><span style="float:right;color:#777;font-size:13px;padding-top:18px;">${e(ref)}</span></div>
      <div style="background:#fff;padding:32px;">${body}</div>
    </div>
  </body></html>`;
}

/** Admin hub: Create order pre-filled from this request (staff login required). */
export function createOrderUrl(req: any): string {
  const hub = (process.env.ADMIN_URL || 'https://hub.solatidebiosciences.com.au').split(',')[0].trim().replace(/\/$/, '');
  return `${hub}/admin/orders/new?fromRequest=${encodeURIComponent(String(req._id))}`;
}

const addressHtml = (a: any) =>
  `${e(a.company)}${a.company ? '<br>' : ''}${e(a.street1)}${a.street2 ? `, ${e(a.street2)}` : ''}<br>${e(a.city)} ${e(a.state)} ${e(a.zip)}<br>${e(a.country)}`;

/** Admin: everything needed to create the order in Admin. Throws on failure (caller logs). */
export async function sendAdminOrderRequestEmail(req: any): Promise<boolean> {
  const to = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.LOW_STOCK_ALERT_EMAIL;
  if (!to) {
    console.warn(`[OrderRequest] ADMIN_NOTIFICATION_EMAIL is not set: no admin email for ${req.requestNumber}`);
    return false;
  }
  const c = req.customer;
  const body = `
    <div style="display:inline-block;background:#e8f2ff;color:#0b4a8b;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;margin-bottom:12px;">NEW ORDER REQUEST</div>
    <h2 style="margin:0 0 6px;font-size:20px;color:#111;">${e(req.requestNumber)} — ${aud(req.total ?? req.subtotal)}</h2>
    <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.55;">Create this order in Admin → Orders → Create order, then send the customer the PayID / bank transfer payment instructions.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;font-size:14px;color:#333;line-height:1.6;">
      <tr><td style="width:120px;color:#777;vertical-align:top;">Customer</td><td><strong>${e(c.firstName)} ${e(c.lastName)}</strong></td></tr>
      <tr><td style="color:#777;vertical-align:top;">Email</td><td>${e(c.email)}</td></tr>
      <tr><td style="color:#777;vertical-align:top;">Phone</td><td>${e(c.phone)}</td></tr>
      <tr><td style="color:#777;vertical-align:top;">Ship to</td><td>${addressHtml(req.shippingAddress)}</td></tr>
      ${req.notes ? `<tr><td style="color:#777;vertical-align:top;">Notes</td><td>${e(req.notes)}</td></tr>` : ''}
    </table>
    ${itemsTable(req)}
    <p style="margin:26px 0 0;"><a href="${e(createOrderUrl(req))}" style="background:#102a5c;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">Create this order in Admin</a></p>
    <p style="margin:10px 0 0;color:#888;font-size:12px;">Opens Create order with the customer, address and items already filled in.</p>`;
  await deliverMail({
    from: from(), to, replyTo: c.email,
    subject: hdr(`New order request ${req.requestNumber} — ${c.firstName} ${c.lastName} (${aud(req.total ?? req.subtotal)})`),
    html: layout('New order request', body, req.requestNumber),
  });
  return true;
}

/** Customer: confirmation that the request was received; payment details follow by email. */
export async function sendCustomerOrderRequestEmail(req: any): Promise<boolean> {
  const c = req.customer;
  const body = `
    <h2 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#111;">We've received your order request</h2>
    <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.55;">Hi ${e(c.firstName)}, thank you for your order request. We'll email you the PayID or bank transfer details needed to complete payment shortly. Your order is not confirmed until payment has been received.</p>
    <p style="margin:0 0 18px;color:#111;font-size:15px;">Request reference: <strong>${e(req.requestNumber)}</strong></p>
    ${itemsTable(req)}
    <p style="margin:18px 0 0;color:#777;font-size:13px;line-height:1.5;">All prices are in AUD and include GST where applicable.</p>
    <div style="margin-top:22px;font-size:14px;color:#555;line-height:1.6;"><strong style="color:#111;">Shipping to</strong><br>${e(c.firstName)} ${e(c.lastName)}<br>${addressHtml(req.shippingAddress)}</div>`;
  await deliverMail({
    from: from(), to: c.email,
    subject: hdr(`We've received your order request ${req.requestNumber}`),
    html: layout('Order request received', body, req.requestNumber),
  });
  return true;
}
