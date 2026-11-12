/**
 * Delivery progress of an order, shared by the orders list, the order page timeline, the
 * Starshipit webhook / scheduled refresh, "Create shipping label" and manual tracking, so every
 * screen shows the same stage.
 *
 * Starshipit reports two kinds of status: the ORDER status (scheduled refresh: Unshipped, Printed,
 * Dispatched…) and the CARRIER tracking status (webhook: InTransit, OutForDelivery, Delivered…).
 * Both are mapped to one stage here, and the stage only moves forward (a later "Dispatched" from the
 * refresh can't undo an "InTransit" from the webhook). Exception / returned are shown as they come.
 */

export type DeliveryStage =
  | 'label_pending' // order created in Starshipit, label not printed yet (international)
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'returned';

/** Forward stages in order; exception / returned sit outside the sequence. */
export const STAGE_RANK: Record<string, number> = {
  label_pending: 0,
  label_created: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
};

export const MANUAL_STAGES: DeliveryStage[] = ['label_created', 'in_transit', 'out_for_delivery', 'delivered'];

/** In transit with no update for this many days → shown as "Delayed". */
export const DELAYED_AFTER_DAYS = 5;

/** Map any Starshipit / carrier status text to a stage (null = says nothing about delivery). */
export function stageFromStatus(raw: unknown): DeliveryStage | null {
  const s = String(raw ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return null;
  if (/returned|returntosender|rts/.test(s)) return 'returned';
  if (/attempted|undeliver|notdelivered|exception|failed|damaged|lost|cardleft/.test(s)) return 'exception';
  if (s.includes('delivered')) return 'delivered';
  if (/outfordelivery|withdriver|onboardfordelivery|awaitingcollection|readyforcollection|readyforpickup/.test(s)) return 'out_for_delivery';
  // Before "in transit": "Unshipped" contains "shipped"
  if (/labelpending|unshipped|pending|ordercreated/.test(s)) return 'label_pending';
  if (/intransit|transit|dispatched|shipped|processed|pickedup|collected|accepted|departed|arrived/.test(s)) return 'in_transit';
  if (/printed|label|manifest|informationreceived|created|booked/.test(s)) return 'label_created';
  return null;
}

type TrackingField = 'labelCreatedAt' | 'inTransitAt' | 'outForDeliveryAt' | 'deliveredAt' | 'exceptionAt' | 'returnedAt';
const STAGE_FIELD: Partial<Record<DeliveryStage, TrackingField>> = {
  label_created: 'labelCreatedAt',
  in_transit: 'inTransitAt',
  out_for_delivery: 'outForDeliveryAt',
  delivered: 'deliveredAt',
  exception: 'exceptionAt',
  returned: 'returnedAt',
};

/**
 * Move the order's delivery stage (mutates `order.tracking`; the caller saves).
 * - forward only, unless `force` (manual tracking: the admin sets the status they see)
 * - reaching a stage fills the earlier milestones that have no date yet
 * - exception / returned are recorded as they come; a later forward stage replaces them
 * Returns true when something changed.
 */
export function applyTrackingStage(order: any, stage: DeliveryStage | null, at: Date = new Date(), opts: { force?: boolean } = {}): boolean {
  if (!stage) return false;
  const t: any = order.tracking ? (typeof order.tracking.toObject === 'function' ? order.tracking.toObject() : { ...order.tracking }) : {};
  const current: DeliveryStage | undefined = t.stage;
  let next = stage;

  if (!opts.force && current) {
    const forward = STAGE_RANK[stage] !== undefined;
    if (forward && STAGE_RANK[current] !== undefined && STAGE_RANK[stage] <= STAGE_RANK[current]) {
      return false; // same or earlier stage: keep the current one
    }
    if (forward && (current === 'exception' || current === 'returned') && STAGE_RANK[stage] < STAGE_RANK.delivered) {
      // A scan after an exception (e.g. back in transit) clears it; anything earlier is ignored
      if (STAGE_RANK[stage] < STAGE_RANK.in_transit) return false;
    }
    if (current === 'delivered' && !forward) return false; // delivered is final
    if (current === stage) return false;
  }

  const field = STAGE_FIELD[next];
  if (field && !t[field]) t[field] = at;
  // Reaching a forward stage implies the earlier ones happened (dates unknown → this time)
  if (STAGE_RANK[next] !== undefined) {
    for (const [s, rank] of Object.entries(STAGE_RANK)) {
      const f = STAGE_FIELD[s as DeliveryStage];
      if (f && rank < STAGE_RANK[next] && rank >= STAGE_RANK.label_created && !t[f]) t[f] = at;
    }
  }
  if (opts.force && STAGE_RANK[next] !== undefined) {
    // Admin moved the status back: forget later milestones
    for (const [s, rank] of Object.entries(STAGE_RANK)) {
      const f = STAGE_FIELD[s as DeliveryStage];
      if (f && rank > STAGE_RANK[next]) t[f] = undefined;
    }
  }
  t.stage = next;
  t.lastUpdateAt = at;
  order.tracking = t;

  // Keep the older deliveryStatus field in step (used by payment-transition guards)
  if (next === 'delivered') order.deliveryStatus = 'delivered';
  else if (next === 'in_transit' || next === 'out_for_delivery') order.deliveryStatus = 'in_transit';
  else if (next === 'label_created' && order.trackingNumber) order.deliveryStatus = 'tracking_added';
  return true;
}

export type DeliverySummaryStage = DeliveryStage | 'not_shipped' | 'delayed';

export interface DeliverySummary {
  stage: DeliverySummaryStage;
  /** Date shown under the status (delivered on / dispatched on / since) */
  at?: Date | null;
  /** Days without an update (delayed) */
  days?: number;
  source?: 'starshipit' | 'manual';
}

/** What the orders list shows. Orders from before `tracking` existed are read from their old fields. */
export function deliverySummary(order: any, now: Date = new Date()): DeliverySummary {
  const t = order.tracking || {};
  let stage: DeliveryStage | null = t.stage || null;
  if (!stage) {
    stage = stageFromStatus(order.shipmentStatus);
    if (!stage && (order.trackingNumber || order.labelUrl)) stage = 'label_created';
    if (!stage && order.starshipitOrderId) stage = 'label_pending';
    if (stage === 'label_pending' && order.trackingNumber) stage = 'label_created';
  }
  const source = order.trackingSource || (order.trackingNumber ? 'starshipit' : undefined);
  if (!stage) return { stage: 'not_shipped' };

  switch (stage) {
    case 'delivered':
      return { stage, at: t.deliveredAt || null, source };
    case 'in_transit':
    case 'out_for_delivery': {
      const since = t.lastUpdateAt || t.inTransitAt || order.shippedAt;
      const days = since ? Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000) : 0;
      if (stage === 'in_transit' && days >= DELAYED_AFTER_DAYS) return { stage: 'delayed', at: since, days, source };
      return { stage, at: stage === 'in_transit' ? (t.inTransitAt || order.shippedAt || null) : (t.outForDeliveryAt || null), source };
    }
    case 'exception':
      return { stage, at: t.exceptionAt || null, source };
    case 'returned':
      return { stage, at: t.returnedAt || null, source };
    case 'label_created':
      return { stage, at: t.labelCreatedAt || order.shippedAt || null, source };
    default:
      return { stage, source };
  }
}

// ─── Carrier scan times ───────────────────────────────────────────────────────

/** Offset (ms) of a time zone from UTC at a given instant, e.g. +11 h for Sydney in summer. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/**
 * Starshipit sends scan times as Australian local time WITHOUT a time zone
 * ("2026-11-12T16:43:00"). Read as-is they shift by the reader's own offset (+5:30 in India,
 * +11 h on a UTC server). Times without an offset are read as `timeZone` (default Sydney —
 * the same as Melbourne) and returned as an exact ISO time; times with an offset are kept.
 * Unparseable → ''.
 */
export function parseCarrierTime(raw: unknown, timeZone = 'Australia/Sydney'): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) {
    const d = new Date(s); // has its own offset ("Z", "+10:00") or another format
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let utc = wall - zoneOffsetMs(wall, timeZone);
  const check = zoneOffsetMs(utc, timeZone); // around a daylight-saving change
  if (wall - check !== utc) utc = wall - check;
  return new Date(utc).toISOString();
}
