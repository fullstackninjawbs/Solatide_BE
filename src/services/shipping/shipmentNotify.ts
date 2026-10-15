import Order from '../../models/order.model';
import { sendShipmentConfirmationEmail } from '../emailService';

/** Plain (not HTML-escaped) http(s) URL, or '' — the email template escapes on output. */
function httpUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Carrier tracking page for a tracking number. Prefers a URL provided by Starshipit.
 * Unknown carriers get no link (the email still shows the tracking number) instead of a
 * Google search, which is what customers used to receive for "MyPostBusiness".
 */
export function buildTrackingUrl(carrier: string | undefined, trackingNumber: string | undefined, providedUrl?: string): string {
  const provided = httpUrl(providedUrl);
  if (provided && !/google\.[a-z.]+\/search/i.test(provided)) return provided;
  if (!trackingNumber) return '';
  const c = String(carrier || '').toLowerCase().replace(/\s+/g, ' ');
  const n = encodeURIComponent(trackingNumber);
  if (/startrack/.test(c)) return `https://startrack.com.au/track/details/${n}`;
  if (/auspost|australia ?post|mypost|ausp?ost|eparcel/.test(c)) return `https://auspost.com.au/mypost/track/#/details/${n}`;
  return '';
}

/** True for the old generic fallback link, so it can be replaced once the carrier is known. */
export const isGenericTrackingUrl = (url: string | undefined): boolean => !!url && /google\.[a-z.]+\/search/i.test(url);

/**
 * Send the "your order has shipped" email at most once per order, no matter how many paths
 * try (admin Create shipment, Starshipit webhook, scheduled tracking refresh) or how they race.
 * The claim (shipmentEmailSentAt) is taken atomically before sending and released if the email
 * could not even be queued, so a later attempt can retry.
 */
export async function sendShipmentEmailOnce(order: any): Promise<boolean> {
  if (!order?._id || !order.trackingNumber) return false;
  const claim = await Order.updateOne({ _id: order._id, shipmentEmailSentAt: null }, { $set: { shipmentEmailSentAt: new Date() } });
  if (claim.modifiedCount !== 1) return false;
  try {
    await sendShipmentConfirmationEmail(order);
    return true;
  } catch (err: any) {
    console.error(`Failed to send shipment email for order ${order.orderNumber ?? order._id}:`, err?.message ?? err);
    await Order.updateOne({ _id: order._id }, { $set: { shipmentEmailSentAt: null } }).catch(() => undefined);
    return false;
  }
}
