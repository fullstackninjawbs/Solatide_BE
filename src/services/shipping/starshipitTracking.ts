import { sendShipmentConfirmationEmail } from '../emailService';

/** Tracking fields as reported by Starshipit (webhook payload or GET /orders details). */
export interface StarshipitTrackingUpdate {
  tracking_number?: string;
  tracking_status?: string;
  carrier?: string;
  carrier_name?: string;
  label_url?: string;
}

const SHIPPED_STATUSES = new Set(['dispatched', 'shipped', 'printed']);

/**
 * Apply a Starshipit tracking update to an order document — shared by the webhook and the
 * scheduled tracking refresh so both behave identically:
 *  - tracking number / status / carrier (and label URL when provided) are updated
 *  - the first time the status becomes printed/dispatched/shipped, the order is marked
 *    shipped + fulfilled and the shipment confirmation email is sent (once)
 * Saves the order only when something changed. Returns what happened.
 */
export async function applyStarshipitTrackingUpdate(order: any, update: StarshipitTrackingUpdate): Promise<{ changed: boolean; newlyShipped: boolean }> {
  let hasChanges = false;
  let isNewlyShipped = false;

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
    // Auto-generate generic tracking URL if we have a tracking number but no URL
    if (order.trackingNumber && !order.trackingUrl) {
      const carrier = order.trackingCarrier || '';
      if (carrier.toLowerCase().includes('auspost') || carrier.toLowerCase().includes('australia post')) {
        order.trackingUrl = `https://auspost.com.au/mypost/track/#/details/${order.trackingNumber}`;
      } else {
        order.trackingUrl = `https://www.google.com/search?q=${order.trackingNumber}`;
      }
    }
    await order.save();
    if (isNewlyShipped) {
      sendShipmentConfirmationEmail(order).catch((err) => console.error('Failed to send shipment email:', err?.message ?? err));
    }
  }
  return { changed: hasChanges, newlyShipped: isNewlyShipped };
}
