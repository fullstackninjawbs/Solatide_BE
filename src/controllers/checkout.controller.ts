/**
 * Bank transfer / PayID checkout (our own checkout, no card processor).
 *
 *   GET  /api/checkout/config            → checkout mode (Admin) + what that checkout needs
 *   POST /api/checkout/bank-order        → place the order (stock reserved), returns id + token
 *   GET  /api/checkout/bank-order/:id    → order + payment details for its method (?accessToken=)
 *
 * The order is created "Awaiting payment" (paymentStatus pending). The admin marks it paid
 * (PATCH /api/admin/order/:id/status) which runs the usual paid side effects without the
 * customer confirmation email (suppressConfirmationEmail).
 */
import { Request, Response, NextFunction } from 'express';
import Order from '../models/order.model';
import Product from '../models/product.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { withOrderNumberRetry } from '../services/orders/orderNumber';
import { resolveCheckoutLines, CheckoutValidationError } from '../services/orders/checkoutItems';
import { decrementStockAtomic, returnStock, type LowStockCrossing, type StockReservation } from '../services/orders/inventory';
import { generateOrderAccessToken, accessTokenMatches } from '../domain/orderAccess';
import {
  getBankTransferSettings, publicCheckoutConfig, validateCheckoutInput, methodsForCountry, shippingFor,
  instructionsFor, isBankMethod, CheckoutInputError, ORDER_NUMBER_ONLY_WARNING, METHOD_LABELS, methodLabel,
} from '../services/checkout/bankTransfer';
import { getCheckoutModeState } from '../services/checkout/checkoutMode';
import { orderRequestShippingConfig } from '../services/checkout/orderRequest';
import { toPublicOrder } from './order.controller';

const round2 = (n: number) => Math.round(n * 100) / 100;
// Single-variant products are often titled "Default Title" (Shopify placeholder): not shown
const variantTitleOf = (t?: string) => (t && !/^default title$/i.test(t.trim()) ? t : undefined);
const CHECKOUT_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * GET /api/checkout/config — the checkout mode chosen in Admin, plus what that checkout needs
 * (bank transfer: methods per country + shipping; order request: shipping). Asked on every
 * "Check out" click, so a mode change applies immediately.
 */
export const getCheckoutConfig = catchAsync(async (_req: Request, res: Response) => {
  const { mode, bank } = await getCheckoutModeState();
  res.set('Cache-Control', 'no-store');
  if (mode === 'bank_transfer') return res.json({ success: true, data: { mode, ...publicCheckoutConfig(bank) } });
  if (mode === 'order_request') return res.json({ success: true, data: { mode, currency: 'AUD', shipping: orderRequestShippingConfig() } });
  res.json({ success: true, data: { mode, currency: 'AUD' } });
});

/** Order + payment details for a token holder (the customer who placed it). */
async function bankOrderResponse(orderId: string) {
  const order: any = await Order.findById(orderId).lean();
  if (!order) return null;
  const s = await getBankTransferSettings();
  return {
    order: {
      ...toPublicOrder(order),
      paymentMethod: order.paymentMethod,
      paymentMethodLabel: isBankMethod(order.paymentMethod) ? methodLabel(order.paymentMethod) : undefined,
      paymentDueAt: order.paymentDueAt,
      customerEmail: order.customer?.email || order.customerEmail,
    },
    payment: isBankMethod(order.paymentMethod)
      ? { ...instructionsFor(order.paymentMethod, s, order), warning: ORDER_NUMBER_ONLY_WARNING }
      : null,
  };
}

export const placeBankOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { mode, bank: s } = await getCheckoutModeState();
  if (mode !== 'bank_transfer') {
    // The admin switched the checkout mode while this customer was on the page
    return next(new AppError('Our checkout has just been updated. Please refresh the page and try again — your cart is saved.', 503));
  }

  // 1) Validate input (server is the source of truth for everything)
  let input: ReturnType<typeof validateCheckoutInput>;
  try {
    input = validateCheckoutInput(req.body);
  } catch (err) {
    if (err instanceof CheckoutInputError) return next(new AppError(err.message, 400));
    throw err;
  }
  const { customer, address, method } = input;
  if (!methodsForCountry(address.country, s).includes(method)) {
    return next(new AppError(address.country === 'AU'
      ? 'Please choose PayID or Bank Transfer for Australian orders.'
      : 'Please choose International Bank Transfer for orders outside Australia.', 400));
  }

  // 2) Same checkout attempt again (double click / retried request) → the order already placed
  const checkoutRequestId = typeof req.body?.checkoutRequestId === 'string' && CHECKOUT_ID_RE.test(req.body.checkoutRequestId)
    ? req.body.checkoutRequestId : null;
  if (!checkoutRequestId) return next(new AppError('Invalid checkout request. Please refresh the page and try again.', 400));
  const already: any = await Order.findOne({ checkoutRequestId }).select('+publicAccessToken').lean();
  if (already) {
    return res.status(200).json({ success: true, data: { orderId: already._id, orderNumber: already.orderNumber, accessToken: already.publicAccessToken, grandTotal: already.grandTotal, repeated: true } });
  }

  // 3) Lines, prices and stock from the database (Tagada variant ids not needed here)
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  let lines;
  try {
    lines = await resolveCheckoutLines(
      items.map((i: any) => ({ productId: i?.productId, variantId: i?.variantId, quantity: i?.quantity })),
      (id) => Product.findById(id).lean(),
      { requireTagadaVariant: false }
    );
  } catch (err) {
    if (err instanceof CheckoutValidationError) return next(new AppError(err.message, 400));
    throw err;
  }
  const products: any[] = await Product.find({ _id: { $in: lines.map((l) => l.product) } }).select('imageUrl images').lean();
  const imageOf = (id: unknown) => {
    const p = products.find((x) => String(x._id) === String(id));
    return p?.imageUrl || p?.images?.[0]?.secureUrl || p?.images?.[0]?.url || undefined;
  };

  const subtotal = round2(lines.reduce((sum, l) => sum + l.price * l.quantity, 0));
  const shipping = shippingFor(address.country, subtotal, s);
  const grandTotal = round2(subtotal + shipping.amount);

  // 4) Reserve stock atomically; if any line can no longer be reserved, undo and refuse
  const reservations: StockReservation[] = [];
  const lowStock: LowStockCrossing[] = [];
  for (const l of lines) {
    const r = await decrementStockAtomic(l.product, l.variant, l.quantity);
    if (!r.ok) {
      await returnStock(reservations);
      // The same checkout attempt (retried request) may have just placed the order
      const placed: any = await Order.findOne({ checkoutRequestId }).select('+publicAccessToken').lean();
      if (placed) return res.status(200).json({ success: true, data: { orderId: placed._id, orderNumber: placed.orderNumber, accessToken: placed.publicAccessToken, grandTotal: placed.grandTotal, repeated: true } });
      return next(new AppError(r.reason === 'oversold'
        ? `Sorry, '${l.title}' just sold out or has fewer units left. Please update your cart.`
        : `'${l.title}' is no longer available. Please update your cart.`, 409));
    }
    if (r.applied) reservations.push({ product: l.product, variant: l.variant, quantity: l.quantity });
    if (r.lowStock) lowStock.push(r.lowStock);
  }

  // 5) Create the order (stock is given back if this fails)
  const now = new Date();
  const name = `${customer.firstName} ${customer.lastName}`.trim();
  const shipTo = { name, company: address.company, street1: address.street1, street2: address.street2, city: address.city, state: address.state, zip: address.zip, country: address.country, phone: customer.phone };
  const accessToken = generateOrderAccessToken();
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const visitor = req.body?.visitor && typeof req.body.visitor === 'object'
    ? { sessionId: str(req.body.visitor.sessionId, 128), country: str(req.body.visitor.country, 100), region: str(req.body.visitor.region, 100), city: str(req.body.visitor.city, 100) }
    : undefined;
  const clipTouch = (t: any) => (t && typeof t === 'object' ? { ...t, source: str(t.source, 255), channel: str(t.channel, 255) } : undefined);
  const attribution = req.body?.attribution && typeof req.body.attribution === 'object'
    ? { firstTouch: clipTouch(req.body.attribution.firstTouch), lastTouch: clipTouch(req.body.attribution.lastTouch) }
    : undefined;

  let order: any;
  try {
    order = await withOrderNumberRetry((orderNumber) => Order.create({
      orderNumber,
      publicAccessToken: accessToken,
      checkoutRequestId,
      source: 'storefront',
      paymentMethod: method,
      paymentStatus: 'pending',
      status: 'pending',
      currency: 'AUD',
      customer: { firstName: customer.firstName, lastName: customer.lastName, email: customer.email, phone: customer.phone },
      customerEmail: customer.email,
      customerName: name,
      shippingAddressObj: shipTo,
      billingAddressObj: shipTo,
      shippingAddress: [address.street1, address.street2, address.city, address.state, address.zip, address.country].filter(Boolean).join(', '),
      lineItems: lines.map((l) => ({ title: l.title || 'Product', variantTitle: variantTitleOf(l.variantTitle), sku: l.sku, quantity: l.quantity, unitPrice: l.price, subtotal: round2(l.price * l.quantity), productImageUrl: imageOf(l.product) })),
      products: lines.map((l) => ({ product: l.product, variant: l.variant, quantity: l.quantity, price: l.price, tagadaVariantId: l.tagadaVariantId || undefined, sku: l.sku, title: l.title, variantTitle: variantTitleOf(l.variantTitle) })),
      subtotal,
      shippingAmount: shipping.amount,
      shippingMethodName: shipping.name,
      // Prices are GST-inclusive; no separate tax line (it read as an extra charge in admin)
      taxAmount: 0,
      discountAmount: 0,
      grandTotal,
      totalAmount: grandTotal,
      // Stock is reserved now; the paid side effects must not decrement it again
      inventoryDecrementedAt: now,
      stockReservations: reservations,
      paymentDueAt: new Date(now.getTime() + s.unpaidCancelDays * 24 * 3600 * 1000),
      // No customer email when the admin marks it paid; never an abandoned-checkout reminder
      suppressConfirmationEmail: true,
      abandonedReminderSentAt: now,
      ...(lowStock.length ? { lowStockAlert: { items: lowStock, at: now } } : {}),
      ...(visitor && (visitor.sessionId || visitor.country) ? { visitor } : {}),
      ...(attribution ? { attribution } : {}),
      comments: [{ text: `Order placed via the website checkout (${METHOD_LABELS[method]}). Awaiting payment.`, createdAt: now }],
    }));
  } catch (err: any) {
    await returnStock(reservations);
    if (err?.code === 11000 && /checkoutRequestId/.test(String(err?.message))) {
      // A concurrent identical request created it first
      const dup: any = await Order.findOne({ checkoutRequestId }).select('+publicAccessToken').lean();
      if (dup) return res.status(200).json({ success: true, data: { orderId: dup._id, orderNumber: dup.orderNumber, accessToken: dup.publicAccessToken, repeated: true } });
    }
    throw err;
  }

  console.log(`[Checkout] Bank transfer order ${order.orderNumber} placed (${METHOD_LABELS[method]}, $${grandTotal} AUD, ${lines.length} line(s))`);

  // 6) Emails + low-stock alert — never fail the order because of them
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mail = require('../services/checkout/bankTransferEmails');
  mail.sendAwaitingPaymentEmail(order, s, accessToken).catch((err: any) => console.error(`[Checkout] Customer email failed for ${order.orderNumber}: ${err?.message}`));
  if (s.notifyAdminOnOrder) {
    mail.sendAdminAwaitingPaymentEmail(order).catch((err: any) => console.error(`[Checkout] Admin email failed for ${order.orderNumber}: ${err?.message}`));
  }
  if (lowStock.length) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../services/lowStockAlert').sendOrderLowStockAlert(order._id).catch((err: any) => console.error(`[Checkout] Low-stock alert failed for ${order.orderNumber}: ${err?.message}`));
  }

  res.status(201).json({ success: true, data: { orderId: order._id, orderNumber: order.orderNumber, accessToken, grandTotal } });
});

export const getBankOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id || '');
  const token = typeof req.query.accessToken === 'string' ? req.query.accessToken.slice(0, 256) : '';
  if (!/^[0-9a-fA-F]{24}$/.test(id) || !token) return next(new AppError('Order not found', 404));
  const doc: any = await Order.findById(id).select('+publicAccessToken').lean();
  if (!doc || doc.isDeleted || !accessTokenMatches(doc.publicAccessToken, token)) return next(new AppError('Order not found', 404));
  const data = await bankOrderResponse(id);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data });
});
