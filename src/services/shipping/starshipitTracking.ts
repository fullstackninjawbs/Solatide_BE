import { buildTrackingUrl, isGenericTrackingUrl, sendShipmentEmailOnce } from './shipmentNotify';
import { applyTrackingStage, stageFromStatus } from './deliveryStatus';

/** Tracking fields as reported by Starshipit (webhook payload or GET /orders details). */
export interface StarshipitTrackingUpdate {
  tracking_number?: string;
  tracking_status?: string;
  carrier?: string;
  carrier_name?: string;
  label_url?: string;
  tracking_url?: string;
}

const SHIPPED_STATUSES = new Set(['dispatched', 'shipped', 'printed']);

/**
 * Apply a Starshipit tracking update to an order document — shared by the webhook and the
 * scheduled tracking refresh so both behave identically:
 *  - tracking number / status / carrier (and label URL when provided) are updated
 *  - when the status becomes printed/dispatched/shipped the order is marked shipped + fulfilled;
 *    the shipment email is only sent when THIS update ships the order (if admin "Create
 *    shipment" already shipped it, that path sent the email) — and at most once per order
 *    either way (sendShipmentEmailOnce), so a webhook racing the admin request can't duplicate it
 * Saves the order only when something changed. Returns what happened.
 */
export async function applyStarshipitTrackingUpdate(order: any, update: StarshipitTrackingUpdate): Promise<{ changed: boolean; newlyShipped: boolean }> {
  let hasChanges = false;
  let isNewlyShipped = false;
  const wasShipped = order.status === 'shipped';

  // Tracking entered manually by an admin (label made outside Starshipit) is not overwritten.
  // If Starshipit reports a different number, note it once on the order so the admin can check.
  if (order.trackingSource === 'manual') {
    const reported = update.tracking_number;
    if (reported && reported !== order.trackingNumber) {
      const note = `Starshipit reported tracking number ${reported}; the manually entered ${order.trackingNumber || 'tracking'} was kept.`;
      if (!(order.comments || []).some((c: any) => c?.text === note)) {
        order.comments = [...(order.comments || []), { text: note, createdAt: new Date() }];
        await order.save();
        return { changed: true, newlyShipped: false };
      }
    }
    return { changed: false, newlyShipped: false };
  }

  if (update.tracking_number && order.trackingNumber !== update.tracking_number) {
    order.trackingNumber = update.tracking_number;
    hasChanges = true;
    order.trackingSource = 'starshipit';
    applyTrackingStage(order, 'label_created');
  }

  if (update.tracking_status && order.shipmentStatus !== update.tracking_status) {
    order.shipmentStatus = update.tracking_status;
    hasChanges = true;
    // Delivery stage: forward only, so the refresh's order status (e.g. "Dispatched") can't undo
    // a carrier status from the webhook (e.g. "InTransit")
    applyTrackingStage(order, stageFromStatus(update.tracking_status));
    const stage = stageFromStatus(update.tracking_status);
    const isShippedStatus = SHIPPED_STATUSES.has(update.tracking_status.toLowerCase())
      || stage === 'in_transit' || stage === 'out_for_delivery' || stage === 'delivered';
    if (isShippedStatus && order.status !== 'delivered') {
      if (order.status !== 'shipped' || order.fulfilmentStatus !== 'fulfilled') {
        order.status = 'shipped';
        order.fulfilmentStatus = 'fulfilled';
        order.shippedAt = new Date();
        isNewlyShipped = true;
      }
    }
  }

  const newCarrier = update.carrier_name || update.carrier;
  if (newCarrier && order.trackingCarrier !== newCarrier) {
    order.trackingCarrier = newCarrier;
    hasChanges = true;
  }

  if (update.label_url && !order.labelUrl) {
    order.labelUrl = update.label_url;
    hasChanges = true;
  }

  if (hasChanges) {
    // Carrier tracking link (also replaces an old generic Google-search link)
    if (order.trackingNumber && (!order.trackingUrl || isGenericTrackingUrl(order.trackingUrl))) {
      const url = buildTrackingUrl(order.trackingCarrier, order.trackingNumber, update.tracking_url);
      if (url) order.trackingUrl = url;
    }
    await order.save();
  }
  if (isNewlyShipped && !wasShipped) {
    await sendShipmentEmailOnce(order);
  }
  return { changed: hasChanges, newlyShipped: isNewlyShipped };
}
