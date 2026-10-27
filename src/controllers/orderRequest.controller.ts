/**
 * Order request checkout (see services/checkout/orderRequest.ts), used when Admin → Settings →
 * Checkout mode is "Order Request" (GET /api/checkout/config lives in checkout.controller.ts).
 *
 *   POST /api/checkout/order-request  → saves the request, emails admin + customer
 */
import { Request, Response, NextFunction } from 'express';
import Product from '../models/product.model';
import OrderRequest from '../models/OrderRequest';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { resolveCheckoutLines, CheckoutValidationError } from '../services/orders/checkoutItems';
import {
  validateOrderRequestInput, OrderRequestInputError, newRequestNumber, orderRequestShippingFor,
  sendAdminOrderRequestEmail, sendCustomerOrderRequestEmail,
} from '../services/checkout/orderRequest';
import { getEffectiveCheckoutMode } from '../services/checkout/checkoutMode';

const round2 = (n: number) => Math.round(n * 100) / 100;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
// Not shown: Shopify's "Default Title" placeholder, or a variant title that just repeats the product name
const variantTitleOf = (t?: string, productName?: string) =>
  (t && !/^default title$/i.test(t.trim()) && t.trim().toLowerCase() !== String(productName || '').trim().toLowerCase() ? t : undefined);

export const submitOrderRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if ((await getEffectiveCheckoutMode()) !== 'order_request') {
    // The admin switched the checkout mode while this customer was on the page
    return next(new AppError('Our checkout has just been updated. Please refresh the page and try again — your cart is saved.', 503));
  }

  let input: ReturnType<typeof validateOrderRequestInput>;
  try {
    input = validateOrderRequestInput(req.body);
  } catch (err) {
    if (err instanceof OrderRequestInputError) return next(new AppError(err.message, 400));
    throw err;
  }

  // One request per submit attempt (double click / retried request → the same request)
  const clientRequestId = typeof req.body?.clientRequestId === 'string' && CLIENT_ID_RE.test(req.body.clientRequestId) ? req.body.clientRequestId : null;
  if (!clientRequestId) return next(new AppError('Invalid request. Please refresh the page and try again.', 400));
  const already: any = await OrderRequest.findOne({ clientRequestId }).select('requestNumber').lean();
  if (already) return res.status(200).json({ success: true, data: { requestNumber: already.requestNumber, repeated: true } });

  // Products, prices and availability from the database (no stock is reserved or changed)
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
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
  const shippingAmount = orderRequestShippingFor(input.address.country, subtotal);
  const total = round2(subtotal + (shippingAmount ?? 0));
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

  let doc: any;
  for (let attempt = 0; attempt < 5 && !doc; attempt++) {
    try {
      doc = await OrderRequest.create({
        requestNumber: newRequestNumber(),
        clientRequestId,
        customer: input.customer,
        shippingAddress: input.address,
        items: lines.map((l) => ({ product: l.product, variant: l.variant, title: l.title || 'Product', variantTitle: variantTitleOf(l.variantTitle, l.title), sku: l.sku, quantity: l.quantity, unitPrice: l.price, subtotal: round2(l.price * l.quantity) })),
        subtotal,
        shippingAmount,
        total,
        currency: 'AUD',
        notes: input.notes || undefined,
        visitor: req.body?.visitor && typeof req.body.visitor === 'object' ? { sessionId: str(req.body.visitor.sessionId, 128), country: str(req.body.visitor.country, 100) } : undefined,
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      if (/clientRequestId/.test(String(err?.message))) {
        const dup: any = await OrderRequest.findOne({ clientRequestId }).select('requestNumber').lean();
        if (dup) return res.status(200).json({ success: true, data: { requestNumber: dup.requestNumber, repeated: true } });
      }
      // requestNumber collision → try another number
    }
  }
  if (!doc) return next(new AppError('Could not save your order request. Please try again.', 500));

  console.log(`[OrderRequest] ${doc.requestNumber} received (${lines.length} line(s), $${subtotal} AUD)`);

  // Emails are queued (retried) when queues are available; never fail the request because of them
  sendAdminOrderRequestEmail(doc)
    .then(async (sent) => { if (sent) await OrderRequest.updateOne({ _id: doc._id }, { $set: { emailedAdminAt: new Date() } }); })
    .catch((err: any) => console.error(`[OrderRequest] Admin email failed for ${doc.requestNumber}: ${err?.message}`));
  sendCustomerOrderRequestEmail(doc)
    .then(async (sent) => { if (sent) await OrderRequest.updateOne({ _id: doc._id }, { $set: { emailedCustomerAt: new Date() } }); })
    .catch((err: any) => console.error(`[OrderRequest] Customer email failed for ${doc.requestNumber}: ${err?.message}`));

  res.status(201).json({ success: true, data: { requestNumber: doc.requestNumber, subtotal, shippingAmount, total } });
});
