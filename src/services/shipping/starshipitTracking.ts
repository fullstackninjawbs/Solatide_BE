import { buildTrackingUrl, isGenericTrackingUrl, sendShipmentEmailOnce } from './shipmentNotify';
import { applyTrackingStage, stageFromStatus, STAGE_RANK } from './deliveryStatus';
import { starshipitService } from './starshipit.service';

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

// ─── Carrier scans (Starshipit GET /track) ───────────────────────────────────────────────────
// The order status Starshipit returns from GET /orders stops at "Printed" / "Dispatched"; where the
// parcel actually is (received by Australia Post, in transit, delivered…) only comes from the carrier
// scans. The order page and the scheduled refresh both read them here, so the Orders list shows the
// same delivery status as the order page without anyone opening the order.

const TRACKING_EVENTS_TTL_MS = 10 * 60 * 1000;
export type TrackingEvents = Awaited<ReturnType<typeof starshipitService.getTrackingEvents>>;
const trackingEventsCache = new Map<string, { at: number; data: TrackingEvents }>();

/** Carrier scans for a tracking number, cached 10 minutes (Starshipit rate limits). */
export async function cachedTrackingEvents(trackingNumber: string, orderNumber?: string): Promise<TrackingEvents> {
  const hit = trackingEventsCache.get(trackingNumber);
  if (hit && Date.now() - hit.at < TRACKING_EVENTS_TTL_MS) return hit.data;
  const data = await starshipitService.getTrackingEvents(trackingNumber, orderNumber);
  if (trackingEventsCache.size > 500) trackingEventsCache.clear();
  trackingEventsCache.set(trackingNumber, { at: Date.now(), data });
  return data;
}

/**
 * Read the carrier scans and move the order's delivery stage on (forward only, with the carrier's
 * own scan times). Saves the order when the stage changed.
 *  - applyStatus: also apply the overall carrier status like the webhook does (marks the order shipped
 *    and sends the shipment email once if it wasn't shipped yet). Used by the scheduled refresh; the
 *    order page leaves it off so opening an order never emails a customer.
 * Manually tracked orders are left alone (Starshipit can't track a number it didn't create).
 */
export async function syncCarrierScans(order: any, opts: { applyStatus?: boolean } = {}): Promise<{
  changed: boolean; newlyShipped: boolean; events: TrackingEvents['events'];
}> {
  if (!order.trackingNumber || order.trackingSource === 'manual' || !order.starshipitOrderId) {
    return { changed: false, newlyShipped: false, events: [] };
  }
  const data = await cachedTrackingEvents(order.trackingNumber, order.orderNumber);
  const events = (data.events || [])
    .filter((e) => e && (e.status || e.details))
    .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
  let changed = false;
  for (const ev of events) {
    const at = new Date(ev.datetime);
    if (isNaN(at.getTime())) continue;
    changed = applyTrackingStage(order, stageFromStatus(ev.status) ?? stageFromStatus(ev.details), at) || changed;
  }
  let r = { changed: false, newlyShipped: false };
  if (opts.applyStatus && data.trackingStatus) {
    // /track may answer with the ORDER status ("Printed") when the carrier has no status yet: never let
    // that overwrite a later carrier status text (the stage itself is forward-only regardless)
    const statusStage = stageFromStatus(data.trackingStatus);
    const current = order.tracking?.stage;
    const behind = statusStage && current && STAGE_RANK[statusStage] !== undefined && STAGE_RANK[current] !== undefined
      && STAGE_RANK[statusStage] < STAGE_RANK[current];
    if (!behind) r = await applyStarshipitTrackingUpdate(order, { tracking_status: data.trackingStatus }); // saves if it changed
  }
  if (changed && !r.changed) await order.save();
  return { changed: changed || r.changed, newlyShipped: r.newlyShipped, events };
}
