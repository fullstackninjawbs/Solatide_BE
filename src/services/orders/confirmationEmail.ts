/**
 * confirmationEmail.ts — the customer's "Order confirmed" email plus a timeline entry.
 *
 * Used when a bank transfer / PayID order is marked paid (onOrderPaid) and by
 * POST /api/admin/order/:id/send-confirmation (Hub → "Send confirmation email").
 * The timeline entry is an order comment, written only after the email was accepted
 * (sent, or queued for sending with retries).
 */
import Order from '../../models/order.model';

export const customerEmailOf = (order: any): string => String(order?.customerEmail || order?.customer?.email || '').trim();

const customerNameOf = (order: any): string =>
  String(order?.customerName || [order?.customer?.firstName, order?.customer?.lastName].filter(Boolean).join(' ') || '').trim();

export async function sendConfirmationWithTimeline(
  order: any,
  send: (order: any) => Promise<unknown>
): Promise<boolean> {
  const email = customerEmailOf(order);
  if (!email) return false;
  await send(order);
  const name = customerNameOf(order);
  const to = name ? `${name} (${email})` : email;
  await Order.updateOne(
    { _id: order._id },
    { $push: { comments: { text: `Order confirmation email sent to ${to}.`, createdAt: new Date() } } }
  );
  return true;
}
