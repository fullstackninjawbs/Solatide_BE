/**
 * tagadaSync.ts — pull the latest order/session from TagadaPay and apply it.
 * Used by: public success-page sync, admin getOrderById auto-sync and the
 * off-request detail refresh in onOrderPaid. Every Tagada call is time-boxed.
 */
import Order from '../../models/order.model';
import { getTagadaClient } from '../tagadaClient';
import { withTimeout } from '../../domain/withTimeout';
import { mapTagadaStatus, PaymentStatus } from '../../domain/orderTransitions';
import { isUsableExternalId } from '../../domain/tagadaWebhook';
import { applyTagadaDetails, unwrapTagadaObject, hasCustomerDetails } from './tagadaOrderMapper';
import { transitionPaymentStatus, TransitionOutcome } from './paymentTransition';
import { ensureOrderNumber } from './orderNumber';

export function pickTagadaLookupId(order: any): string | null {
  for (const v of [order.tagadaOrderId, order.tagadaSessionId, order.tagadaPaymentId]) {
    if (isUsableExternalId(v)) return v;
  }
  return null;
}

export async function fetchTagadaObject(targetId: string, timeoutMs = 15000): Promise<any> {
  const client = await getTagadaClient();
  const call = targetId.startsWith('cs_')
    ? client.checkout.retrieveSession(targetId)
    : client.orders.retrieve(targetId);
  return unwrapTagadaObject(await withTimeout(call, timeoutMs, 'tagada.retrieve'));
}

export type SyncResult = {
  order: any;
  mapped: PaymentStatus | null;
  transition?: TransitionOutcome;
  becamePaid: boolean;
};

/**
 * Fetch from Tagada, copy details, and apply a *payment* transition
 * (paid / failed / cancelled only — refunds are handled by the webhook so
 * amounts are reconciled in one place).
 */
export async function syncOrderFromTagada(orderId: unknown, opts: { timeoutMs?: number } = {}): Promise<SyncResult> {
  const order: any = await Order.findById(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  const targetId = pickTagadaLookupId(order);
  if (!targetId) throw Object.assign(new Error('No Tagada session/order ID found on this order'), { statusCode: 400 });

  const fullOrder = await fetchTagadaObject(targetId, opts.timeoutMs ?? 15000);
  applyTagadaDetails(order, fullOrder, {});
  if (isUsableExternalId(fullOrder?.orderId) && !order.tagadaOrderId) order.tagadaOrderId = fullOrder.orderId;
  await order.save({ validateBeforeSave: false });

  const mapped = mapTagadaStatus(fullOrder?.status, null);
  let transition: TransitionOutcome | undefined;
  if (mapped === 'paid' || mapped === 'failed' || mapped === 'cancelled') {
    transition = await transitionPaymentStatus(order._id, mapped);
  }
  const becamePaid = mapped === 'paid' && !!transition && (transition.result === 'applied' || transition.result === 'noop');
  if (becamePaid) await ensureOrderNumber(order._id);
  const fresh = await Order.findById(order._id);
  return { order: fresh, mapped, transition, becamePaid };
}

/** Off-request enrichment: retry up to 3× (2 s apart) until customer details appear. */
export async function refreshTagadaDetails(orderId: unknown): Promise<void> {
  const order: any = await Order.findById(orderId);
  if (!order) return;
  const targetId = pickTagadaLookupId(order);
  if (!targetId) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const obj = await fetchTagadaObject(targetId, 10000);
      if (hasCustomerDetails(obj)) {
        applyTagadaDetails(order, obj, {});
        await order.save({ validateBeforeSave: false });
        return;
      }
    } catch (err: any) {
      console.warn(`[TagadaSync] refresh attempt ${attempt}/3 for order=${orderId} failed: ${err?.message}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
}
