/**
 * onOrderPaid.ts — idempotent post-payment side effects (H-4).
 *
 * Every code path that moves an order to `paid` (webhook, public success-page
 * sync, admin auto-sync, admin manual order / status change) calls
 * `onOrderPaid(orderId)`. Only the caller that wins the atomic claim
 *   {paymentStatus ∈ paid-ish, paidAt ≠ null, sideEffectsClaimedAt: null} → now
 * runs the side effects, so they happen exactly once regardless of ordering.
 * `paidAt` is required so orders paid before this change (no paidAt) are never
 * re-processed (no duplicate emails for legacy orders).
 *
 * Each step is isolated: a failure is recorded in `sideEffectErrors`
 * (capped at 20) and the remaining steps still run.
 *
 * Retries (background queue, see queues/processors.ts): every step that succeeds is recorded in
 * `sideEffectStepsDone`, and `sideEffectsCompletedAt` is only set once ALL steps succeeded.
 * With { resume: true } an order that was claimed but not completed (crash mid-way, or a step
 * failed) is picked up again and only the remaining steps run — no duplicate emails.
 */
import Order from '../../models/order.model';
import Customer from '../../models/Customer';
import Discount from '../../models/Discount';
import AnalyticsEvent from '../../models/analyticsEvent.model';
import { decrementInventoryForOrder } from './inventory';
import { checkDiscountEligibility } from '../../domain/discountEligibility';
import { escapeRegExp } from '../../domain/escapeRegExp';

export interface OnOrderPaidDeps {
  sendOrderConfirmationEmail: (order: any) => Promise<unknown>;
  sendAdminNewOrderNotificationEmail: (order: any) => Promise<unknown>;
  validateOrderAddress: (orderId: unknown) => Promise<unknown>;
  /** Best-effort deactivation of a provider promotion once its usage cap is reached */
  deactivatePromotion?: (tagadaPromotionId: string) => Promise<unknown>;
  /** Optional enrichment before emails when the paid order still lacks a customer email */
  refreshOrderDetails?: (orderId: unknown) => Promise<unknown>;
}

let defaultDeps: OnOrderPaidDeps | null = null;

/** Override the default dependencies (tests / alternative wiring). Pass null to reset. */
export function setDefaultOnOrderPaidDeps(deps: OnOrderPaidDeps | null): void {
  defaultDeps = deps;
}

/** Lazily resolve real implementations so tests (and module load) never touch SMTP/Google/Tagada. */
function loadDefaultDeps(): OnOrderPaidDeps {
  if (defaultDeps) return defaultDeps;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const email = require('../emailService');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const addr = require('../addressValidation.service').default;
  defaultDeps = {
    sendOrderConfirmationEmail: email.sendOrderConfirmationEmail,
    sendAdminNewOrderNotificationEmail: email.sendAdminNewOrderNotificationEmail,
    validateOrderAddress: (id: unknown) => addr.validateOrderAddress(id),
    refreshOrderDetails: (id: unknown) => require('./tagadaSync').refreshTagadaDetails(id),
    deactivatePromotion: async (promoId: string) => {
      const { getTagadaClient } = require('../tagadaClient');
      const { withTimeout } = require('../../domain/withTimeout');
      const client = await getTagadaClient();
      return withTimeout(client.promotions.update(promoId, { active: false }), 15000, 'tagada.promotions.update');
    },
  };
  return defaultDeps;
}

export const PAID_SIDE_EFFECT_STATUSES = ['paid', 'partially_refunded'];

async function recordStepError(orderId: unknown, step: string, err: unknown) {
  const message = (err as any)?.message ? String((err as any).message).slice(0, 500) : String(err).slice(0, 500);
  console.error(`[onOrderPaid] order=${orderId} step=${step} failed: ${message}`);
  try {
    await Order.updateOne(
      { _id: orderId },
      { $push: { sideEffectErrors: { $each: [{ step, message, at: new Date() }], $slice: -20 } } }
    );
  } catch (e) {
    console.error(`[onOrderPaid] could not record error for order=${orderId}:`, (e as any)?.message);
  }
}

export type OnOrderPaidResult = { claimed: false } | { claimed: true; resumed?: boolean; errors: string[] };

export async function onOrderPaid(
  orderId: unknown,
  deps?: Partial<OnOrderPaidDeps>,
  opts: { resume?: boolean } = {}
): Promise<OnOrderPaidResult> {
  let resumed = false;
  let order: any = await Order.findOneAndUpdate(
    {
      _id: orderId,
      paymentStatus: { $in: PAID_SIDE_EFFECT_STATUSES },
      paidAt: { $ne: null },
      sideEffectsClaimedAt: null,
    },
    { $set: { sideEffectsClaimedAt: new Date() } },
    { new: true }
  ).select('+publicAccessToken');
  if (!order && opts.resume) {
    // Claimed earlier but not completed: continue with the steps that have not succeeded yet.
    // Only the queue worker resumes (one job per order), so this never runs concurrently.
    order = await Order.findOne({
      _id: orderId,
      paymentStatus: { $in: PAID_SIDE_EFFECT_STATUSES },
      paidAt: { $ne: null },
      sideEffectsClaimedAt: { $ne: null },
      sideEffectsCompletedAt: null,
    }).select('+publicAccessToken');
    resumed = !!order;
  }
  if (!order) return { claimed: false };
  const done = new Set<string>(Array.isArray(order.sideEffectStepsDone) ? order.sideEffectStepsDone : []);

  const complete = !!deps?.sendOrderConfirmationEmail && !!deps?.sendAdminNewOrderNotificationEmail && !!deps?.validateOrderAddress;
  const d: OnOrderPaidDeps = complete ? (deps as OnOrderPaidDeps) : { ...loadDefaultDeps(), ...(deps ?? {}) };
  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    if (done.has(name)) return; // succeeded in an earlier attempt
    try {
      await fn();
      done.add(name);
      await Order.updateOne({ _id: order._id }, { $addToSet: { sideEffectStepsDone: name } });
    } catch (err) {
      errors.push(name);
      await recordStepError(order._id, name, err);
    }
  };

  console.log(`[onOrderPaid] order=${order._id} number=${order.orderNumber ?? '-'} ${resumed ? 'resumed' : 'claimed'} side effects`);

  // 0) If the customer email is still missing (webhook arrived before Tagada populated it), try once more.
  if (!order.customerEmail && !order.customer?.email && d.refreshOrderDetails) {
    await step('refresh_details', () => d.refreshOrderDetails!(order._id));
    const fresh = await Order.findById(order._id);
    if (fresh) Object.assign(order, { customer: fresh.customer, customerEmail: fresh.customerEmail, customerName: fresh.customerName, shippingAddressObj: fresh.shippingAddressObj, lineItems: fresh.lineItems });
  }

  // 1) Inventory (skipped if already decremented, e.g. admin manual orders)
  if (!order.inventoryDecrementedAt) {
    await step('inventory', async () => {
      const claim = await Order.updateOne(
        { _id: order._id, inventoryDecrementedAt: null },
        { $set: { inventoryDecrementedAt: new Date() } }
      );
      if (claim.modifiedCount === 1) await decrementInventoryForOrder(order);
    });
  }

  // 2) Customer confirmation email
  if (!order.suppressConfirmationEmail && (order.customerEmail || order.customer?.email)) {
    await step('confirmation_email', () => d.sendOrderConfirmationEmail(order));
  }

  // 3) Admin notification (admin-created manual orders are notified at creation)
  if (order.source !== 'admin_manual') {
    await step('admin_notification', () => d.sendAdminNewOrderNotificationEmail(order));
  }

  // 4) Customer CRM upsert (email normalised to lowercase)
  const email = String(order.customer?.email || order.customerEmail || '').trim().toLowerCase();
  if (email) {
    await step('customer_upsert', async () => {
      const name = order.customerName ||
        [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || 'Unknown Customer';
      const country = order.shippingAddressObj?.country || order.billingAddressObj?.country || '';
      const set: Record<string, unknown> = { name };
      if (country) set.country = country;
      if (order.shippingAddressObj?.street1) set.defaultAddress = order.shippingAddressObj;
      await Customer.findOneAndUpdate(
        { email },
        { $set: set, $setOnInsert: { email }, $inc: { orderCount: 1, totalSpent: order.grandTotal || order.totalAmount || 0 } },
        { upsert: true, new: true }
      );
    });
  }

  // 5) Address validation (skip if already checked)
  if (order.shippingAddressObj?.street1 && !order.addressValidation?.checkedAt) {
    await step('address_validation', () => d.validateOrderAddress(order._id));
  }

  // 6) Discount usage — match on the actual code; guarded atomic increment.
  const codeCandidate: string | undefined = order.couponCode || order.discountDescription;
  if (codeCandidate) {
    await step('discount_usage', async () => {
      const discount: any = await Discount.findOne({
        code: { $regex: `^${escapeRegExp(codeCandidate, 64)}$`, $options: 'i' },
      });
      if (!discount) return;
      if (!order.couponCode) await Order.updateOne({ _id: order._id }, { $set: { couponCode: discount.code } });

      const customerUses = email
        ? await Order.countDocuments({
          _id: { $ne: order._id },
          couponCode: discount.code,
          customerEmail: email,
          paymentStatus: { $in: ['paid', 'partially_refunded', 'refunded'] },
        })
        : 0;
      const eligibility = checkDiscountEligibility(discount, {
        now: order.paidAt ?? new Date(),
        subtotal: order.subtotal ?? order.grandTotal,
        customerUses,
      });

      const maxUses = Number(discount.maxUses) || 0;
      const filter: any = { _id: discount._id };
      if (maxUses > 0) filter.$expr = { $lt: ['$usesSoFar', '$maxUses'] };
      const updated: any = await Discount.findOneAndUpdate(filter, { $inc: { usesSoFar: 1 } }, { new: true });

      let violation = eligibility.ok ? null : { code: eligibility.code, reason: eligibility.reason };
      if (!updated) violation = { code: 'max_uses', reason: 'Discount usage limit already reached when order was paid.' };
      if (violation) {
        console.warn(`[onOrderPaid] order=${order._id} discount ${discount.code} violation: ${violation.code}`);
        await Order.updateOne({ _id: order._id }, { $set: { discountViolation: { ...violation, at: new Date() } } });
      }
      if (updated && maxUses > 0 && updated.usesSoFar >= maxUses) {
        await Discount.updateOne({ _id: discount._id }, { $set: { status: 'expired' } });
        if (discount.tagadaPromotionId && d.deactivatePromotion) await d.deactivatePromotion(discount.tagadaPromotionId);
      }
    });
  }

  // 7) Server-side purchase analytics event (trusted; clientReported:false)
  await step('analytics', async () => {
    await AnalyticsEvent.create({
      sessionId: order.attribution?.lastTouch?.sessionId || order.attribution?.firstTouch?.sessionId || `order:${order._id}`,
      eventType: 'purchase',
      orderId: order._id,
      cartValue: order.grandTotal ?? order.totalAmount ?? 0,
      // No location: analytics shows where the VISITOR is (the browser's purchase event carries
      // that); the shipping address is where the order goes, not the visitor
      page: `/order/${order._id}`,
      path: `/order/${order._id}`,
      clientReported: false,
      timestamp: order.paidAt ?? new Date(),
    });
  });

  if (errors.length === 0) {
    await Order.updateOne({ _id: order._id }, { $set: { sideEffectsCompletedAt: new Date() } });
    console.log(`[onOrderPaid] order=${order._id} side effects complete`);
  } else {
    console.warn(`[onOrderPaid] order=${order._id} side effects incomplete (failed: ${errors.join(',')}) — will be retried by the queue when available`);
  }
  return { claimed: true, resumed, errors };
}

/**
 * Fire-and-forget wrapper for request handlers: queued background job (retried, survives
 * restarts) when queues are available, otherwise in-process right after the response.
 * Passing deps (tests / alternative wiring) always runs in-process.
 */
export function scheduleOnOrderPaid(orderId: unknown, deps?: Partial<OnOrderPaidDeps>): void {
  if (!deps) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../queues/producers').enqueueOrderPaid(orderId);
    return;
  }
  setImmediate(() => {
    onOrderPaid(orderId, deps).catch((err) =>
      console.error(`[onOrderPaid] order=${orderId} unexpected failure:`, err?.message ?? err)
    );
  });
}
