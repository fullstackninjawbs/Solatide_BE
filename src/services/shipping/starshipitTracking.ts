import { buildTrackingUrl, isGenericTrackingUrl, sendShipmentEmailOnce } from './shipmentNotify';

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

  if (update.tracking_number && order.trackingNumber !== update.tracking_number) {
    order.trackingNumber = update.tracking_number;
    hasChanges = true;
  }

  if (update.tracking_status && order.shipmentStatus !== update.tracking_status) {
    order.shipmentStatus = update.tracking_status;
    hasChanges = true;
    if (SHIPPED_STATUSES.has(update.tracking_status.toLowerCase())) {
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
