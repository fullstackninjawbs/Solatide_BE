/**
 * confirmationEmail.ts — the customer's "Order confirmed" email plus a timeline entry.
 *
 * Used for every automatic confirmation (onOrderPaid), pending manual orders created with
 * "Send order confirmation email" ticked, and POST /api/admin/order/:id/send-confirmation
 * (Hub → "Send confirmation email"). The timeline entry is an order comment, written only after
 * the email was accepted (sent, or queued for sending with retries) — the Hub timeline shows
 * an email as sent only when this entry exists.
 */
import Order from '../../models/order.model';

export const customerEmailOf = (order: any): string => String(order?.customerEmail || order?.customer?.email || '').trim();

const customerNameOf = (order: any): string =>
  String(order?.customerName || [order?.customer?.firstName, order?.customer?.lastName].filter(Boolean).join(' ') || '').trim();

/** "Jane Doe (jane@x.com)" / "jane@x.com" for timeline entries; "an admin" when unknown. */
export const adminLabelOf = (user: any): string => {
  const email = String(user?.email || '').trim();
  const name = String(user?.name || '').trim();
  if (name && email && name !== email) return `${name} (${email})`;
  return email || name || 'an admin';
};

export async function sendConfirmationWithTimeline(
  order: any,
  send: (order: any) => Promise<unknown>,
  sentBy?: string
): Promise<boolean> {
  const email = customerEmailOf(order);
  if (!email) return false;
  await send(order);
  const name = customerNameOf(order);
  const to = name ? `${name} (${email})` : email;
  const now = new Date();
  await Order.updateOne(
    { _id: order._id },
    {
      $set: { confirmationEmailSentAt: now },
      $push: { comments: { text: `Order confirmation email sent to ${to}${sentBy ? ` by ${sentBy}` : ''}.`, createdAt: now } },
    }
  );
  return true;
}
