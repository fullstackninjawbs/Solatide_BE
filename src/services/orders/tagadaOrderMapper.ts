/**
 * tagadaOrderMapper.ts
 * ────────────────────
 * Copies customer / address / line-item / totals / shipping data from a
 * TagadaPay order|session object (or webhook data) onto our Order document.
 * Shared by the webhook, the public success-page sync and the admin auto-sync.
 *
 * Units: Tagada `*Amount` / `unitAmount` fields are minor units (cents) and are
 * converted with fromMinorUnits; Shopify-style `*_price` fields are major units.
 * Does NOT touch paymentStatus / status / fulfilment — see paymentTransition.ts.
 */
import { fromMinorUnits } from '../../domain/money';

function firstDefined<T>(...vals: T[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Extract an actual promotion CODE (never a free-text description). */
export function extractCouponCode(fullOrder: any, summary: any): string | undefined {
  const adjustments: any[] = summary?.adjustments || fullOrder?.adjustments || [];
  for (const adj of adjustments) {
    const code = adj?.promotionCode?.code ?? adj?.code ?? adj?.promotionCodeCode ?? adj?.couponCode;
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  const dc = fullOrder?.discount_codes?.[0]?.code ?? fullOrder?.discountCodes?.[0]?.code;
  if (typeof dc === 'string' && dc.trim()) return dc.trim();
  const pc = fullOrder?.promotionCode?.code ?? fullOrder?.couponCode ?? fullOrder?.promotionCodes?.[0]?.code;
  if (typeof pc === 'string' && pc.trim()) return pc.trim();
  return undefined;
}

export function applyTagadaDetails(order: any, fullOrder: any, dAny: any = {}): void {
  fullOrder = fullOrder || {};

  // ── Customer snapshot ───────────────────────────────────────────────────────
  const cust = fullOrder.customer || dAny.customer || dAny.user_data || fullOrder.user_data;
  if (cust) {
    const saForPhone = fullOrder.shippingAddress || fullOrder.shipping_address || dAny.shippingAddress || dAny.shipping_address || {};
    const resolvedPhone = firstDefined(
      cust.phone, cust.phoneNumber, cust.phone_number,
      saForPhone.phone, saForPhone.phoneNumber, saForPhone.phone_number,
      dAny.phone, dAny.phoneNumber, dAny.phone_number
    );
    const email = String(firstDefined(cust.email, dAny.email, dAny.user_data?.email) ?? '').trim().toLowerCase();
    order.customer = {
      firstName: cust.firstName ?? cust.first_name ?? order.customer?.firstName ?? '',
      lastName: cust.lastName ?? cust.last_name ?? order.customer?.lastName ?? '',
      email: email || order.customer?.email || '',
      phone: resolvedPhone ?? order.customer?.phone,
    };
    if (order.customer.email) order.customerEmail = order.customer.email;
    order.customerName =
      [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ') || order.customerName;
  }

  // ── Shipping address ────────────────────────────────────────────────────────
  const sa = fullOrder.shippingAddress || fullOrder.shipping_address || fullOrder.customer?.shippingAddress ||
    dAny.shippingAddress || dAny.shipping_address || dAny.customer?.shippingAddress;
  if (sa) {
    order.shippingAddressObj = {
      name: sa.name ?? (`${sa.firstName || ''} ${sa.lastName || ''}`.trim() || undefined),
      company: sa.company ?? undefined,
      street1: sa.address1 ?? sa.line1 ?? undefined,
      street2: sa.address2 ?? sa.line2 ?? undefined,
      city: sa.city ?? undefined,
      state: sa.province ?? sa.state ?? undefined,
      zip: sa.zip ?? sa.postalCode ?? sa.postal ?? undefined,
      country: sa.country ?? undefined,
      phone: sa.phone ?? sa.phoneNumber ?? sa.phone_number ?? undefined,
    };
    const addressPhone = sa.phone ?? sa.phoneNumber ?? sa.phone_number;
    if (addressPhone && !order.customer?.phone) {
      order.customer = { ...(order.customer?.toObject?.() ?? order.customer ?? {}), phone: addressPhone };
    }
    const s = order.shippingAddressObj;
    order.shippingAddress = [s.street1, s.street2, s.city, s.state, s.zip, s.country].filter(Boolean).join(', ');
  }

  // ── Billing address ─────────────────────────────────────────────────────────
  const ba = fullOrder.billingAddress || fullOrder.billing_address || fullOrder.customer?.billingAddress ||
    dAny.billingAddress || dAny.billing_address || dAny.customer?.billingAddress;
  if (ba) {
    order.billingAddressObj = {
      name: ba.name ?? (`${ba.firstName || ''} ${ba.lastName || ''}`.trim() || undefined),
      company: ba.company ?? undefined,
      street1: ba.address1 ?? ba.line1 ?? undefined,
      street2: ba.address2 ?? ba.line2 ?? undefined,
      city: ba.city ?? undefined,
      state: ba.province ?? ba.state ?? undefined,
      zip: ba.zip ?? ba.postalCode ?? ba.postal ?? undefined,
      country: ba.country ?? undefined,
    };
  }

  // ── Line items ──────────────────────────────────────────────────────────────
  const lineItems = fullOrder.items || fullOrder.lineItems || fullOrder.line_items || dAny.lineItems || dAny.line_items;
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    order.lineItems = lineItems.map((item: any) => {
      const unitPrice = item.unitAmount != null
        ? fromMinorUnits(item.unitAmount)
        : (num(item.unitPrice) ?? num(item.price) ?? 0);
      const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
      return {
        title: item.orderLineItemProduct?.name ?? item.productName ?? item.name ?? item.title ?? 'Unknown Product',
        variantTitle: item.orderLineItemVariant?.name ?? item.variantName ?? item.variantTitle ?? item.variant_title ?? undefined,
        sku: item.sku ?? item.orderLineItemVariant?.sku ?? undefined,
        quantity: qty,
        unitPrice,
        subtotal: Math.round(unitPrice * qty * 100) / 100,
        productImageUrl: item.orderLineItemVariant?.imageUrl ?? item.imageUrl ?? item.image_url ?? undefined,
      };
    });
  }

  // ── Totals ──────────────────────────────────────────────────────────────────
  const summary = fullOrder.summaries?.[0] || {};
  const minorOrMajor = (minor: unknown, major: unknown): number | undefined =>
    minor !== undefined && minor !== null ? fromMinorUnits(minor as number) : num(major);

  const subtotal = summary.subtotalAmount !== undefined ? fromMinorUnits(summary.subtotalAmount) : minorOrMajor(fullOrder.subtotalAmount, fullOrder.subtotal_price);
  if (subtotal !== undefined) order.subtotal = subtotal;

  const shipping = summary.shippingCost !== undefined ? fromMinorUnits(summary.shippingCost) : minorOrMajor(fullOrder.shippingAmount, fullOrder.shipping_price);
  if (shipping !== undefined) order.shippingAmount = shipping;

  const tax = summary.totalTaxAmount !== undefined ? fromMinorUnits(summary.totalTaxAmount) : minorOrMajor(fullOrder.taxAmount, fullOrder.tax_price);
  if (tax !== undefined) order.taxAmount = tax;

  const discountAmt = summary.totalPromotionAmount !== undefined
    ? fromMinorUnits(summary.totalPromotionAmount)
    : (minorOrMajor(fullOrder.totalPromotionAmount, fullOrder.discount_price) ?? 0);
  if (discountAmt > 0) {
    order.discountAmount = discountAmt;
    const code = extractCouponCode(fullOrder, summary);
    if (code) order.couponCode = code;
    const adjustments: any[] = summary.adjustments || fullOrder.adjustments || [];
    const desc = adjustments.find((a: any) => a?.description)?.description;
    if (typeof desc === 'string') order.discountDescription = desc.slice(0, 200);
  }

  const total = summary.totalAdjustedAmount !== undefined
    ? fromMinorUnits(summary.totalAdjustedAmount)
    : summary.totalAmount !== undefined
      ? fromMinorUnits(summary.totalAmount)
      : minorOrMajor(fullOrder.totalAmount, fullOrder.total_price);
  if (total !== undefined) {
    order.grandTotal = total;
    order.totalAmount = total;
  }
  if (summary.currency || fullOrder.currency) order.currency = summary.currency || fullOrder.currency;

  // ── Shipping method ─────────────────────────────────────────────────────────
  const firstShipping = fullOrder.shipping_lines?.[0] || fullOrder.shippingLines?.[0];
  const sdkShippingRate = fullOrder.checkoutSession?.shippingRate || fullOrder.shippingRate || fullOrder.shipping_rate || dAny.shippingRate || dAny.shipping_rate;
  const sdkShippingName = fullOrder.checkoutSession?.shippingRateName || fullOrder.shippingRateName || fullOrder.shippingMethod || fullOrder.shipping_method || dAny.shippingMethod || dAny.shipping_method;
  const code = fullOrder.checkoutSession?.shippingRateId || fullOrder.shippingRateId || dAny.shippingRateId || firstShipping?.code ||
    (sdkShippingRate && typeof sdkShippingRate === 'object' ? (sdkShippingRate.id || sdkShippingRate.code) : undefined);

  if (firstShipping) {
    order.shippingMethodName = firstShipping.title ?? firstShipping.name ?? undefined;
    order.shippingMethodCode = firstShipping.code ?? undefined;
  } else if (sdkShippingRate && typeof sdkShippingRate === 'object') {
    order.shippingMethodName = sdkShippingRate.shippingRateName || sdkShippingRate.name || sdkShippingRate.title || 'Standard Shipping';
    order.shippingMethodCode = sdkShippingRate.id || sdkShippingRate.code;
  } else if (sdkShippingName && typeof sdkShippingName === 'string') {
    order.shippingMethodName = sdkShippingName;
    order.shippingMethodCode = code || undefined;
  } else if (code) {
    order.shippingMethodCode = code;
    order.shippingMethodName = 'Standard Shipping';
  }
}

/** Unwrap SDK responses: `{ order }`, `{ session }` or the object itself. */
export function unwrapTagadaObject(res: any): any {
  return res?.order || res?.session || res;
}

export function hasCustomerDetails(obj: any): boolean {
  return !!(obj && (obj.customer || obj.shippingAddress || obj.shipping_address || obj.billingAddress));
}
