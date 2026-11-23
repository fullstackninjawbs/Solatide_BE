import { starshipitRequest } from './starshipitHttp';
import { parseCarrierTime } from './deliveryStatus';
import { IOrder } from '../../models/order.model';
import ShippingPackage from '../../models/shippingPackage.model';
import { ShipmentWeight, PackageChoice, packageTareGrams } from './shipmentWeight';
import { isLabelExistsElsewhereError } from './labelDuplicates';
import dotenv from 'dotenv';

dotenv.config();

function parseStarshipitError(data: any, fallback: string): string {
  if (!data) return fallback;
  let rawMsg = fallback;
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const errs = data.errors.map((e: any) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') {
        return e.details || e.message || JSON.stringify(e);
      }
      return String(e);
    }).filter(Boolean);
    if (errs.length > 0) rawMsg = errs.join('; ');
  } else if (data.validation_errors) {
    if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
      const errs = data.validation_errors.map((ve: any) => {
        if (typeof ve === 'string') return ve;
        return ve.details || ve.message || ve.error || (ve.field ? `${ve.field}: ${ve.message || ve.error}` : JSON.stringify(ve));
      }).filter(Boolean);
      if (errs.length > 0) rawMsg = errs.join('; ');
    } else {
      rawMsg = typeof data.validation_errors === 'string' ? data.validation_errors : JSON.stringify(data.validation_errors);
    }
  } else if (typeof data.details === 'string' && data.details.trim()) {
    rawMsg = data.details;
  } else if (typeof data.message === 'string' && data.message.trim()) {
    rawMsg = data.message;
  } else if (typeof data.error === 'string' && data.error.trim()) {
    rawMsg = data.error;
  } else if (typeof data.error_message === 'string' && data.error_message.trim()) {
    rawMsg = data.error_message;
  }

  if (rawMsg.includes('Unable to get order details from order_id') || rawMsg.includes('Unable to get order details')) {
    return 'Destination address or country is unconfigured in Starshipit. Update shipping address or enable international courier in Starshipit.';
  }

  if (rawMsg.includes('could not be created, but the import step did not return a specific validation error')) {
    return 'Shipping address is incomplete OR your Starshipit account is not configured with an International Courier capable of delivering to this country. Please verify the address, and ensure you have an international courier enabled in Starshipit.';
  }

  return rawMsg;
}

function getNormalizedShippingMethod(order: IOrder): string {
  const methodName = order.shippingMethodName;
  if (!methodName) {
    console.warn(`WARNING: Order ${order.orderNumber || order._id} is missing shippingMethodName. Returning empty string instead of blind fallback.`);
    return '';
  }

  const country = order.shippingAddressObj?.country?.toUpperCase() || 'AU';

  if (country !== 'AU') {
    if (methodName.startsWith('Standard - $')) {
      return 'Standard';
    }
    if (methodName.startsWith('Express - $')) {
      return 'Express';
    }
  }

  return methodName;
}

/** All Starshipit HTTP calls are bounded (L-9). */
const STARSHIPIT_TIMEOUT_MS = 15000;
/** `code` of the error getShipmentDetails throws when Starshipit has no such order. */
export const STARSHIPIT_ORDER_NOT_FOUND = 'STARSHIPIT_ORDER_NOT_FOUND';

/**
 * Buying labels. POST /orders/shipment buys a label from the carrier (charged to the carrier
 * account, e.g. MyPost Business) EVERY time it is called — it is not idempotent. So:
 *  - before buying, the Starshipit order is read; if it already has a label/tracking, nothing is bought
 *  - the purchase is sent once (never retried on timeout / 5xx; only on 429 = refused outright)
 *  - when the answer is unclear (timeout, network error, 5xx) Starshipit is read again instead of retrying
 *  - if Starshipit can't be read before buying, nothing is bought
 *
 * Reading an order: GET /orders?order_id= only returns OPEN (unshipped) orders — once a label is
 * printed/shipped Starshipit answers "Unable to get order details". Shipped (manifested) orders
 * are read from GET /orders/shipped (filtered by since_last_updated, not sorted). Orders printed
 * but never manifested (e.g. a plain label, no tracking) are in neither list.
 */
const SHIPPED_PAGE_SIZE = 100;
const SHIPPED_MAX_PAGES = 5;

/** Where to look for an order that is no longer open (lookup hints). */
export type LocateHints = { orderNumber?: string; since?: Date | string };
const LABEL_PURCHASE_TIMEOUT_MS = 30000;
const RECHECK_DELAY_MS = 1500;

export type StarshipitDetails = {
  trackingNumber: string;
  trackingCarrier: string;
  labelUrl: string;
  trackingUrl: string;
  shipmentStatus: string;
};

/**
 * existing        Starshipit already had a label → nothing bought
 * purchased       one label bought (or found right after an unclear answer)
 * failed          Starshipit answered that no label was created → nothing bought
 * unconfirmed     no clear answer (timeout / network / 5xx) and no label visible yet → may have been bought; don't retry
 * precheck_failed Starshipit couldn't be read before buying → nothing bought
 */
export type LabelOutcome =
  | { kind: 'existing'; details: StarshipitDetails }
  | { kind: 'purchased'; details: StarshipitDetails }
  | { kind: 'failed'; error: string; details?: StarshipitDetails; existsElsewhere?: boolean }
  | { kind: 'unconfirmed'; error: string }
  | { kind: 'precheck_failed'; error: string };

/** Archived / cancelled in Starshipit (e.g. its label was voided): never reused, never synced, never bought on. */
export function starshipitOrderIsArchived(o: any): boolean {
  return /^(archived|cancelled|canceled|deleted)$/i.test(String(o?.status || '').trim());
}

/** Starshipit order statuses that mean a label exists ("Unshipped"/"New" do not). */
const LABELLED_STATUSES = new Set(['printed', 'shipped', 'manifested', 'dispatched', 'delivered', 'in transit', 'intransit']);

/** Tracking / label / status from a Starshipit order (GET /orders). */
export function detailsFromStarshipitOrder(o: any): StarshipitDetails {
  const pkg = Array.isArray(o?.packages) && o.packages.length ? o.packages[0] : null;
  return {
    trackingNumber: o?.tracking_number || pkg?.tracking_number || '',
    trackingCarrier: o?.carrier || o?.carrier_name || '',
    labelUrl: o?.label_url || o?.pdf_url || pkg?.labels?.[0]?.label_url || '',
    trackingUrl: o?.tracking_url || pkg?.tracking_url || '',
    shipmentStatus: o?.status || '',
  };
}

/** True when the Starshipit order already has a label (so buying another would be a duplicate charge). */
export function starshipitOrderHasLabel(o: any): boolean {
  if (!o) return false;
  const d = detailsFromStarshipitOrder(o);
  if (d.trackingNumber || d.labelUrl) return true;
  if (Array.isArray(o.packages) && o.packages.some((p: any) => p?.tracking_number || (Array.isArray(p?.labels) && p.labels.length))) return true;
  return LABELLED_STATUSES.has(String(o.status || '').trim().toLowerCase());
}

/** Tracking / label from the POST /orders/shipment reply (several shapes seen across API versions). */
export function detailsFromLabelResponse(data: any): StarshipitDetails {
  const o = data?.order || (Array.isArray(data?.orders) ? data.orders[0] : null) || {};
  const labels = Array.isArray(data?.labels) ? data.labels : [];
  const labelObj = labels.find((l: any) => l && typeof l === 'object') || {};
  const trackingList = Array.isArray(data?.tracking_numbers) ? data.tracking_numbers.filter(Boolean) : [];
  return {
    trackingNumber: o.tracking_number || trackingList[0] || data?.tracking_number || labelObj.tracking_number || '',
    trackingCarrier: o.carrier || o.carrier_name || data?.carrier_name || data?.carrier || labelObj.carrier || '',
    labelUrl: o.label_url || o.pdf_url || data?.label_url || labelObj.label_url || labelObj.pdf_url || '',
    trackingUrl: o.tracking_url || data?.tracking_url || '',
    shipmentStatus: o.status || '',
  };
}

const mergeDetails = (a: StarshipitDetails, b: StarshipitDetails | null | undefined): StarshipitDetails => (b ? {
  trackingNumber: a.trackingNumber || b.trackingNumber,
  trackingCarrier: a.trackingCarrier || b.trackingCarrier,
  labelUrl: a.labelUrl || b.labelUrl,
  trackingUrl: a.trackingUrl || b.trackingUrl,
  shipmentStatus: b.shipmentStatus || a.shipmentStatus,
} : a);

/** No usable answer from Starshipit (timeout, network error, 5xx): the request may or may not have been processed. */
const isUnclearFailure = (err: any) => !err?.response || err.response.status >= 500;

/** Shown when MyPost refused the label because one already exists (error 51015) — nothing was bought by this request. */
export const LABEL_EXISTS_ELSEWHERE_MESSAGE = 'A label already exists in Starshipit for this order (Australia Post refused a new one: "generated via a different service"). No new label was bought. Do NOT create or print another one — click "Check Starshipit now" to pull in the tracking, and check Starshipit / MyPost Business for a duplicate label to refund.';

/** Message for the admin after a label attempt (undefined = all good). */
export function labelWarning(outcome: LabelOutcome): string | undefined {
  switch (outcome.kind) {
    case 'existing': return undefined;
    case 'purchased': return outcome.details.trackingNumber ? undefined : 'Label created in Starshipit; the tracking number has not come through yet — use "Check Starshipit now" in a minute.';
    case 'failed': return outcome.existsElsewhere ? LABEL_EXISTS_ELSEWHERE_MESSAGE : outcome.error;
    case 'unconfirmed': return 'Starshipit did not confirm whether the label was created. To avoid a double charge it was NOT retried. Use "Check Starshipit now" in a minute, or open the order in Starshipit: if it is under Printed, use Reprint label (no charge) — do not use Redo shipping.';
    case 'precheck_failed': return `${outcome.error}, so no label was bought (to avoid a double charge). Use "Check Starshipit now" in a minute and try again if needed.`;
  }
}

export class StarshipitService {
  private readonly baseUrl = 'https://api.starshipit.com/api';

  private get requestConfig() {
    return { headers: this.headers, timeout: STARSHIPIT_TIMEOUT_MS };
  }

  private get headers() {
    const apiKey = process.env.STARSHIPIT_API_KEY;
    const subscriptionKey = process.env.STARSHIPIT_SUBSCRIPTION_KEY;

    if (!apiKey || !subscriptionKey) {
      console.warn('WARNING: Starshipit API keys are not fully configured.');
    }

    return {
      'StarShipIT-Api-Key': apiKey || '',
      'Ocp-Apim-Subscription-Key': subscriptionKey || '',
      'Content-Type': 'application/json'
    };
  }

  public async createShipment({ order, origin, weightKg, weight, packageChoice }: { order: IOrder, origin: any, weightKg: number, weight?: ShipmentWeight, packageChoice?: PackageChoice }): Promise<{
    orderId: string;
    trackingNumber?: string;
    trackingCarrier?: string;
    labelUrl?: string;
    trackingUrl?: string;
    shipmentStatus?: string;
    warning?: string;
    parcel?: { totalGrams: number; itemsGrams: number; packageGrams: number; packageName?: string; packageReason?: string };
    outcome: LabelOutcome['kind'];
    /** MyPost refused the label because one already exists (51015) — nothing bought by this request. */
    existsElsewhere?: boolean;
  }> {
    const itemsCount = order.lineItems?.length || 1;
    const weightPerItem = weightKg / itemsCount;

    // The package chosen for this order (product-selected packages, largest wins; else Default).
    // Without a choice (older callers) the Default package is used, as before.
    const defaultPackage: any = packageChoice ? packageChoice.pkg : await ShippingPackage.findOne({ isDefault: true, active: true });
    // Parcel weight = contents + empty package (previously only the empty package was sent, so
    // Starshipit quoted/rated a parcel of a few grams)
    const itemsGrams = weight ? weight.itemsGrams : Math.round(weightKg * 1000);
    const packageGrams = packageTareGrams(defaultPackage);
    const parcel = { totalGrams: itemsGrams + packageGrams, itemsGrams, packageGrams, packageName: defaultPackage?.name, packageReason: packageChoice?.reason };

    const street = order.shippingAddressObj?.street1 || (typeof order.shippingAddress === 'string' ? order.shippingAddress : undefined);
    const suburb = order.shippingAddressObj?.city || order.shippingAddressObj?.street2;
    const city = order.shippingAddressObj?.city;
    const state = order.shippingAddressObj?.state;
    const postCode = order.shippingAddressObj?.zip;
    const country = order.shippingAddressObj?.country || 'AU';

    const payload: any = {
      order_date: new Date().toISOString(),
      order_number: order.orderNumber || order._id?.toString(),
      reference: order.orderNumber || order._id?.toString(),
      shipping_method: getNormalizedShippingMethod(order),
      sender_details: {
        name: 'SB Fulfilment',
        company: 'SB Fulfilment'
      },
      destination: {
        name: order.shippingAddressObj?.name || (order.customer?.firstName ? `${order.customer.firstName} ${order.customer.lastName || ''}`.trim() : 'Customer'),
        company: order.shippingAddressObj?.company,
        street: street,
        suburb: suburb,
        city: city,
        state: state,
        post_code: postCode,
        country: country,
        phone: order.customer?.phone || (order.shippingAddressObj as any)?.phone || (order.billingAddressObj as any)?.phone || '',
        email: order.customer?.email || order.customerEmail || ''
      },
      // Per-unit weight in kg (Starshipit multiplies by quantity)
      items: weight && weight.lines.length > 0
        ? weight.lines.map((l) => ({
          description: l.description,
          sku: l.sku || 'UNKNOWN',
          quantity: l.quantity,
          weight: l.unitGrams / 1000,
          value: l.value
        }))
        : (order.lineItems && order.lineItems.length > 0)
        ? order.lineItems.map(item => ({
          description: item.title,
          sku: item.sku || 'UNKNOWN',
          quantity: item.quantity,
          weight: weightPerItem,
          value: item.unitPrice
        }))
        : [{
          description: 'Order Items',
          sku: 'MIXED',
          quantity: 1,
          weight: weightKg,
          value: order.subtotal || 0
        }]
    };

    if (defaultPackage) {
      payload.packages = [{
        weight: Math.max(parcel.totalGrams, 1) / 1000,
        length: defaultPackage.dimensions?.length ? defaultPackage.dimensions.length / 100 : 0.1,
        width: defaultPackage.dimensions?.width ? defaultPackage.dimensions.width / 100 : 0.1,
        height: defaultPackage.dimensions?.height ? defaultPackage.dimensions.height / 100 : 0.1
      }];
    }
    // If no default package, we completely omit 'packages' array to prevent "blank package" API errors
    // Starshipit will fallback to the default package set in their own dashboard or calculate from items.

    // 1. The Starshipit order (creating it is free; only the label costs money)
    let starshipitOrderId = order.starshipitOrderId;
    const orderNumber = String(payload.order_number);
    try {
      if (!starshipitOrderId) {
        // An earlier attempt may have created it without us hearing back (timeout): reuse it
        let found: any = null;
        try {
          found = await this.findOrderByNumber(orderNumber);
        } catch {
          throw new Error('Could not reach Starshipit to check this order. Nothing was created or charged — please try again in a minute.');
        }
        if (found?.order_id) {
          starshipitOrderId = String(found.order_id);
          console.log(`Order ${orderNumber} already exists in Starshipit (ID: ${starshipitOrderId}); reusing it.`);
        }
      }

      if (!starshipitOrderId) {
        // Payload contains customer PII (name/address/phone/email) — log identifiers only (L-11).
        console.log(`Sending order ${orderNumber} to Starshipit /orders (${payload.items.length} items, country=${country})`);
        let response: any;
        try {
          response = await starshipitRequest('post', `${this.baseUrl}/orders`, { order: payload }, this.requestConfig, { repeatable: false });
        } catch (createErr: any) {
          if (!isUnclearFailure(createErr)) throw createErr;
          // No clear answer: it may have been created anyway
          const recovered = await this.findOrderByNumber(orderNumber).catch(() => null);
          if (!recovered?.order_id) throw createErr;
          response = { status: 200, data: { success: true, order: recovered } };
          console.warn(`Starshipit POST /orders gave no clear answer for ${orderNumber}, but the order exists (ID: ${recovered.order_id}).`);
        }

        console.log('Starshipit POST /orders HTTP Status:', response.status);
        const starshipitOrder = response.data?.order;

        // Soft failure (HTTP 200, success=false): Starshipit may still have CREATED the order — save its id
        if (response.data && response.data.success === false) {
          const errMsg = parseStarshipitError(response.data, 'Starshipit API returned success=false');
          console.error('Starshipit returned soft failure. Detail:', errMsg);
          if (starshipitOrder && starshipitOrder.order_id) {
            console.warn(`Starshipit created order ${starshipitOrder.order_id} but reported a soft failure. Saving order_id to prevent duplicate imports.`);
            return {
              orderId: String(starshipitOrder.order_id),
              trackingNumber: starshipitOrder.tracking_number || '',
              trackingCarrier: starshipitOrder.carrier || '',
              labelUrl: '',
              warning: errMsg,
              parcel,
              outcome: 'failed' as const,
            };
          }
          throw new Error(errMsg);
        }

        if (!starshipitOrder || !starshipitOrder.order_id) {
          throw new Error('Invalid response from Starshipit API: Missing order_id');
        }
        starshipitOrderId = String(starshipitOrder.order_id);
      } else {
        console.log(`Order ${orderNumber} already in Starshipit (ID: ${starshipitOrderId}). Skipping import step.`);
      }
    } catch (error: any) {
      console.error(`Starshipit API Error: ${error.response?.status ?? ''} ${error.message}`);
      throw new Error(parseStarshipitError(error.response?.data, error.message || 'Failed to create shipment with Starshipit'));
    }

    // 2. The label: bought at most once, never when Starshipit already has one
    const outcome = await this.purchaseLabel(starshipitOrderId, { orderNumber, since: (order as any).createdAt });
    const details = 'details' in outcome && outcome.details ? outcome.details : null;
    return {
      orderId: starshipitOrderId,
      trackingNumber: details?.trackingNumber || '',
      trackingCarrier: details?.trackingCarrier || '',
      labelUrl: details?.labelUrl || '',
      trackingUrl: details?.trackingUrl || '',
      shipmentStatus: details?.shipmentStatus || '',
      warning: labelWarning(outcome),
      parcel,
      outcome: outcome.kind,
      existsElsewhere: outcome.kind === 'failed' && Boolean(outcome.existsElsewhere),
    };
  }

  /** One Starshipit order by its Starshipit id; null when Starshipit says it doesn't exist. Throws when Starshipit can't be read. */
  public async findOrder(starshipitOrderId: string): Promise<any | null> {
    try {
      const response = await starshipitRequest('get', `${this.baseUrl}/orders`, undefined, { ...this.requestConfig, params: { order_id: starshipitOrderId } }, { repeatable: true });
      const o = response.data?.order || (Array.isArray(response.data?.orders) ? response.data.orders[0] : null);
      if (!o) return null;
      if (o.order_id != null && String(o.order_id) !== String(starshipitOrderId)) return null; // never trust a different order
      return o;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * One Starshipit order by our order number (to find an order an earlier, timed-out attempt created).
   * Null when not found — including any 4xx answer, so an unexpected "not found" format never blocks
   * creating the order. Throws only when Starshipit can't be reached (network / 5xx).
   */
  public async findOrderByNumber(orderNumber: string): Promise<any | null> {
    try {
      const response = await starshipitRequest('get', `${this.baseUrl}/orders`, undefined, { ...this.requestConfig, params: { order_number: orderNumber } }, { repeatable: true });
      const list = response.data?.order ? [response.data.order] : (Array.isArray(response.data?.orders) ? response.data.orders : []);
      // An archived match (label voided, order archived) is not reused: a fresh order is created instead
      return list.find((o: any) => o && String(o.order_number) === String(orderNumber) && !starshipitOrderIsArchived(o)) || null;
    } catch (err: any) {
      if (err?.response && err.response.status < 500) return null;
      throw err;
    }
  }

  /**
   * A shipped (manifested) Starshipit order, from GET /orders/shipped updated since `since`
   * (default: last 30 days). Matched by Starshipit id; by order number only when no id matches.
   * Null when not in the list. Throws when Starshipit can't be read.
   */
  public async findShippedOrder(starshipitOrderId: string, hints: LocateHints = {}): Promise<any | null> {
    const sinceDate = hints.since ? new Date(hints.since) : new Date(Date.now() - 30 * 86400000);
    const since = new Date(sinceDate.getTime() - 86400000).toISOString(); // a day earlier: clock/time-zone slack
    let byNumber: any = null;
    for (let page = 1; page <= SHIPPED_MAX_PAGES; page++) {
      const response = await starshipitRequest('get', `${this.baseUrl}/orders/shipped`, undefined,
        { ...this.requestConfig, params: { since_last_updated: since, limit: SHIPPED_PAGE_SIZE, page } }, { repeatable: true });
      const list: any[] = Array.isArray(response.data?.orders) ? response.data.orders : [];
      const byId = list.find((o) => o && String(o.order_id) === String(starshipitOrderId));
      if (byId) return { ...byId, status: byId.status || 'Shipped' };
      if (!byNumber && hints.orderNumber) {
        const m = list.find((o) => o && String(o.order_number) === String(hints.orderNumber) && !starshipitOrderIsArchived(o));
        if (m) byNumber = { ...m, status: m.status || 'Shipped' };
      }
      const totalPages = Number(response.data?.total_pages) || 1;
      if (!list.length || page >= totalPages) break;
    }
    return byNumber;
  }

  /**
   * Read-only: Starshipit's shipped (manifested) orders updated since `since` (up to
   * SHIPPED_MAX_PAGES pages). Used by the daily duplicate-label check. Throws when Starshipit can't be read.
   */
  public async listShippedSince(since: Date): Promise<{ orders: any[]; truncated: boolean }> {
    const sinceIso = since.toISOString();
    const orders: any[] = [];
    for (let page = 1; page <= SHIPPED_MAX_PAGES; page++) {
      const response = await starshipitRequest('get', `${this.baseUrl}/orders/shipped`, undefined,
        { ...this.requestConfig, params: { since_last_updated: sinceIso, limit: SHIPPED_PAGE_SIZE, page } }, { repeatable: true });
      const list: any[] = Array.isArray(response.data?.orders) ? response.data.orders : [];
      orders.push(...list.filter(Boolean));
      const totalPages = Number(response.data?.total_pages) || 1;
      if (!list.length || page >= totalPages) return { orders, truncated: false };
      if (page === SHIPPED_MAX_PAGES) return { orders, truncated: true };
    }
    return { orders, truncated: false };
  }

  /** The order wherever Starshipit still returns it: open orders first, then shipped. Null = in neither. */
  public async locateOrder(starshipitOrderId: string, hints: LocateHints = {}): Promise<any | null> {
    const open = await this.findOrder(starshipitOrderId);
    if (open) return open;
    return this.findShippedOrder(starshipitOrderId, hints);
  }

  /** Read-only: the Starshipit order's current tracking / label / status (never buys anything).
   *  Archived orders come back with archived=true and no tracking (a voided label must never be synced). */
  public async readDetails(starshipitOrderId: string, hints: LocateHints = {}): Promise<(StarshipitDetails & { archived?: boolean }) | null> {
    const o = await this.locateOrder(starshipitOrderId, hints);
    if (!o) return null;
    if (starshipitOrderIsArchived(o)) {
      return { trackingNumber: '', trackingCarrier: '', labelUrl: '', trackingUrl: '', shipmentStatus: String(o.status || 'Archived'), archived: true };
    }
    return detailsFromStarshipitOrder(o);
  }

  private async recheck(starshipitOrderId: string, hints: LocateHints): Promise<any | null> {
    await new Promise((r) => setTimeout(r, RECHECK_DELAY_MS));
    return this.locateOrder(starshipitOrderId, hints).catch(() => null);
  }

  /** Buys the label for an order already in Starshipit — at most once, never when one exists. */
  public async purchaseLabel(starshipitOrderId: string, hints: LocateHints = {}): Promise<LabelOutcome> {
    // Before buying: does Starshipit already have a label for it? (open orders, then shipped)
    let current: any;
    try {
      current = await this.locateOrder(starshipitOrderId, hints);
    } catch (err: any) {
      console.warn(`Starshipit pre-check failed for order_id ${starshipitOrderId}: ${err?.response?.status ?? ''} ${err?.message}`);
      return { kind: 'precheck_failed', error: 'Could not check the label status in Starshipit' };
    }
    // In neither list: printed but not manifested (e.g. a plain label), or gone — never buy blind
    if (!current) return { kind: 'precheck_failed', error: 'Starshipit does not show this order as open (it may already be printed there)' };
    if (starshipitOrderIsArchived(current)) {
      return { kind: 'failed', error: 'This order is archived in Starshipit, so no label was bought. Create the label in Starshipit, or add the tracking manually' };
    }
    if (starshipitOrderHasLabel(current)) {
      console.log(`Starshipit order_id ${starshipitOrderId} already has a label — not buying another.`);
      return { kind: 'existing', details: detailsFromStarshipitOrder(current) };
    }

    console.log(`Buying label: POST /orders/shipment for order_id ${starshipitOrderId}`);
    let response: any;
    try {
      response = await starshipitRequest('post', `${this.baseUrl}/orders/shipment`, { order_id: parseInt(starshipitOrderId, 10) },
        { headers: this.headers, timeout: LABEL_PURCHASE_TIMEOUT_MS }, { repeatable: false, charges: true });
    } catch (err: any) {
      console.warn(`Starshipit POST /orders/shipment failed for order_id ${starshipitOrderId}: ${err?.response?.status ?? err?.code ?? ''} ${err?.message}`);
      if (!isUnclearFailure(err)) {
        const error = parseStarshipitError(err.response?.data, err.message || 'Label generation failed in Starshipit');
        return { kind: 'failed', error, ...(isLabelExistsElsewhereError(error) ? { existsElsewhere: true } : {}) };
      }
      // No clear answer — the label may have been bought. Look, don't retry.
      const after = await this.recheck(starshipitOrderId, hints);
      if (after && starshipitOrderHasLabel(after)) return { kind: 'purchased', details: detailsFromStarshipitOrder(after) };
      return { kind: 'unconfirmed', error: 'Starshipit did not confirm whether the label was created' };
    }

    console.log(`Starshipit POST /orders/shipment HTTP ${response.status} success=${response.data?.success}`);
    if (response.data && response.data.success === false) {
      // Starshipit says no label — confirm before reporting (soft failures have created records before)
      const after = await this.recheck(starshipitOrderId, hints);
      if (after && starshipitOrderHasLabel(after)) return { kind: 'purchased', details: detailsFromStarshipitOrder(after) };
      const error = parseStarshipitError(response.data, 'Label generation failed in Starshipit');
      return { kind: 'failed', error, ...(isLabelExistsElsewhereError(error) ? { existsElsewhere: true } : {}) };
    }

    let details = detailsFromLabelResponse(response.data);
    if (!details.trackingNumber || !details.labelUrl) {
      // Bought; fill in what the reply didn't include (read-only)
      details = mergeDetails(details, (await this.recheck(starshipitOrderId, hints).then((o) => (o ? detailsFromStarshipitOrder(o) : null))));
    }
    return { kind: 'purchased', details };
  }

  public async getShipmentDetails(orderId: string): Promise<{
    trackingNumber?: string;
    trackingCarrier?: string;
    labelUrl?: string;
    shipmentStatus?: string;
    trackingUrl?: string;
  }> {
    try {
      const response = await starshipitRequest('get', `${this.baseUrl}/orders`, undefined, { ...this.requestConfig, params: { order_id: orderId } }, { repeatable: true });
      console.log(`Starshipit GetShipmentDetails order_id=${orderId} HTTP ${response.status}`);
      const order = response.data?.order || (response.data?.orders && response.data.orders[0]);

      if (!order) {
        throw Object.assign(new Error('Order not found in Starshipit'), { code: STARSHIPIT_ORDER_NOT_FOUND });
      }

      let trackingNumber = order.tracking_number || '';
      let trackingCarrier = order.carrier || '';
      let labelUrl = order.label_url || order.pdf_url || '';
      let trackingUrl = order.tracking_url || '';
      let shipmentStatus = order.status || '';

      if (order.packages && order.packages.length > 0) {
        const pkg = order.packages[0];
        trackingNumber = trackingNumber || pkg.tracking_number || '';
        trackingUrl = trackingUrl || pkg.tracking_url || '';

        if (pkg.labels && pkg.labels.length > 0) {
          labelUrl = labelUrl || pkg.labels[0].label_url || '';
        }
      }

      return {
        trackingNumber,
        trackingCarrier,
        labelUrl,
        trackingUrl,
        shipmentStatus
      };
    } catch (error: any) {
      if (error.code === STARSHIPIT_ORDER_NOT_FOUND) throw error;
      console.error(`Starshipit Get Shipment Details Error: ${error.response?.status ?? ''} ${error.message}`);
      throw new Error(error.response?.data?.message || 'Failed to fetch shipment details from Starshipit');
    }
  }

  public async getTrackingEvents(trackingNumber: string, orderNumber?: string): Promise<{
    carrierName?: string;
    carrierService?: string;
    trackingStatus?: string;
    shipmentDate?: string;
    lastUpdatedDate?: string;
    events: Array<{
      datetime: string;
      status: string;
      details: string;
    }>;
  }> {
    try {
      const params: any = {};
      if (trackingNumber) params.tracking_number = trackingNumber;
      if (orderNumber) params.order_number = orderNumber;

      const response = await starshipitRequest(
        'get',
        `${this.baseUrl}/track`,
        undefined,
        { ...this.requestConfig, params },
        { repeatable: true }
      );

      const res = response.data?.results || response.data;
      if (!res) {
        return { events: [] };
      }

      const rawEvents = res.tracking_events || res.events || [];
      const events = Array.isArray(rawEvents)
        ? rawEvents.map((e: any) => ({
            // Australian local time without a zone → exact time (see parseCarrierTime)
            datetime: parseCarrierTime(e.event_datetime || e.datetime),
            status: e.status || '',
            details: e.details || e.description || '',
          }))
        : [];

      return {
        carrierName: res.carrier_name,
        carrierService: res.carrier_service,
        trackingStatus: res.tracking_status || res.order_status,
        shipmentDate: res.shipment_date,
        lastUpdatedDate: res.last_updated_date,
        events,
      };
    } catch (err: any) {
      console.warn(`[Starshipit] getTrackingEvents failed for tracking=${trackingNumber}:`, err.message);
      return { events: [] };
    }
  }
}

export const starshipitService = new StarshipitService();
