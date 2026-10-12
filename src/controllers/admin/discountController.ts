import { Request, Response, NextFunction } from 'express';
import Discount from '../../models/Discount';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import { getTagadaClient } from '../../services/tagadaClient';
import PaymentSettings from '../../models/PaymentSettings';
import config from '../../config';
import { escapeRegExp } from '../../domain/escapeRegExp';
import { pickDiscountFields } from '../../domain/discountEligibility';
import { withTimeout, TAGADA_TIMEOUT_MS } from '../../domain/withTimeout';
import { isDuplicateKeyError } from '../../services/orders/orderNumber';

/**
 * Limits (maxUses, perCustomerLimit, activeFrom/To, minPurchase) are enforced
 * LOCALLY: the SDK's PromotionCreateParams / PromotionCodeCreateParams are
 * untyped (`[key: string]: unknown`), so there is no verified provider field
 * for them. Enforcement points: optional pre-check in createTagadaPayment and
 * an atomic guarded usage increment in services/orders/onOrderPaid.ts, which
 * also deactivates the Tagada promotion once maxUses is reached. The Tagada
 * promotion is kept in sync for active/inactive status.
 */

const tagada = <T>(p: Promise<T>, label: string) => withTimeout(p, TAGADA_TIMEOUT_MS, label);

function providerActive(discount: any): boolean {
  const now = Date.now();
  if (discount.status !== 'active') return false;
  if (discount.activeFrom && new Date(discount.activeFrom).getTime() > now) return false;
  if (discount.activeTo && new Date(discount.activeTo).getTime() < now) return false;
  if (discount.maxUses > 0 && discount.usesSoFar >= discount.maxUses) return false;
  return true;
}

async function createProviderPromotion(discount: any): Promise<void> {
  const client = await getTagadaClient();
  const isPercentage = discount.type === 'percent';
  const promo = await tagada<any>(client.promotions.create({
    name: discount.code,
    discountType: isPercentage ? 'percentage' : 'fixed_amount',
    discountValue: discount.value,
    active: providerActive(discount),
  }), 'tagada.promotions.create');

  let promoCode: any;
  try {
    promoCode = await tagada<any>(client.promotionCodes.create({ promotion: promo.id, code: discount.code }), 'tagada.promotionCodes.create');
  } catch (err: any) {
    console.error(`[TagadaPay] Failed to create promotion code for ${discount.code}: ${err?.message}`);
  }
  discount.tagadaPromotionId = promo.id;
  if (promoCode) discount.tagadaPromotionCodeId = promoCode.id;
  await discount.save({ validateBeforeSave: false });
}

// GET /api/admin/discount
export const getDiscounts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status as string;
  const filter: any = {};
  if (search) {
    filter.code = { $regex: escapeRegExp(search, 100), $options: 'i' };
  }
  if (status && status !== 'all' && ['active', 'expired', 'disabled'].includes(status)) {
    filter.status = status;
  }

  const discounts = await Discount.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Discount.countDocuments(filter);

  const orgId = config.tagadaOrgId || 'gracie-collins-1779009767064524065';
  const storeId = (config.tagadaStoreId || 'store_6b8fa1a123cf').trim();
  const tagadaPortalUrl = `https://app.tagada.io/org/${orgId}/stores/${storeId}/general/promotions/discounts`;

  res.status(200).json({
    success: true,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    data: {
      discounts,
      tagadaPortalUrl,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
});

// POST /api/admin/discount/sync-from-tagada
export const syncFromTagada = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const client = await getTagadaClient();
  const settings = await PaymentSettings.findOne();
  const storeId = config.tagadaStoreId || (settings as any)?.tagadaStoreId;

  if (!storeId) {
    return next(new AppError('Tagada Pay Store ID is not configured.', 400));
  }

  let tagadaPromotions: any[] = [];
  let tagadaCodes: any[] = [];

  try {
    const promoData: any = await tagada(client.promotions.list({ storeId }), 'tagada.promotions.list');
    tagadaPromotions = Array.isArray(promoData) ? promoData : (promoData.items || promoData.data || promoData.promotions || []);
    const codeData: any = await tagada(client.promotionCodes.list({ storeId }), 'tagada.promotionCodes.list');
    tagadaCodes = Array.isArray(codeData) ? codeData : (codeData.items || codeData.data || codeData.promotionCodes || []);
    console.log(`[TagadaPay] Fetched ${tagadaPromotions.length} promotions / ${tagadaCodes.length} codes`);
  } catch (err: any) {
    console.error('[TagadaPay] Failed to fetch existing promotions:', err?.response?.status ?? '', err?.message);
    return next(new AppError('Failed to fetch from Tagada Pay.', 502));
  }

  let imported = 0;

  for (const promo of tagadaPromotions) {
    const codeObj = tagadaCodes.find((c: any) => c.promotionId === promo.id);
    // Only an actual promotion code is used — never the promotion name/description.
    const actualCode = codeObj?.code || promo.code;
    if (!actualCode || typeof actualCode !== 'string') continue;

    const usedCount = Number(codeObj?.timesUsed ?? promo.timesUsed ?? codeObj?.usageCount ?? promo.usageCount ?? 0) || 0;

    const exists = await Discount.findOne({ code: actualCode });
    if (!exists) {
      try {
        await Discount.create({
          code: actualCode,
          type: promo.discountType === 'percentage' ? 'percent' : 'fixed',
          value: Number(promo.discountValue) || 0,
          status: (codeObj ? codeObj.active : true) && (promo.enabled ?? promo.active) ? 'active' : 'disabled',
          tagadaPromotionId: promo.id,
          tagadaPromotionCodeId: codeObj?.id,
          appliesTo: 'all',
          usesSoFar: usedCount,
        });
        imported++;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    } else if (usedCount > (exists.usesSoFar || 0)) {
      // Never move the local counter backwards (local counter is authoritative for limits).
      await Discount.updateOne({ _id: exists._id, usesSoFar: { $lt: usedCount } }, { $set: { usesSoFar: usedCount } });
    }
  }

  res.status(200).json({ success: true, message: `Successfully imported ${imported} coupons from Tagada Pay.` });
});

// GET /api/admin/discount/:id
export const getDiscountById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.findById(req.params.id);
  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }
  res.status(200).json({ success: true, data: { discount } });
});

// POST /api/admin/discount
export const createDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { data, errors } = pickDiscountFields(req.body, { partial: false });
  if (errors.length) return next(new AppError(errors.join('; '), 400));

  let discount: any;
  try {
    discount = await Discount.create(data);
  } catch (err) {
    if (isDuplicateKeyError(err, 'code')) return next(new AppError('A discount with this code already exists.', 409));
    throw err;
  }

  try {
    await createProviderPromotion(discount);
  } catch (err: any) {
    console.error(`[TagadaPay] Failed to sync new discount ${discount.code}: ${err?.message}`);
  }

  res.status(201).json({ success: true, data: { discount } });
});

// PUT /api/admin/discount/:id
export const updateDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { data, errors } = pickDiscountFields(req.body, { partial: true });
  if (errors.length) return next(new AppError(errors.join('; '), 400));

  let discount: any;
  try {
    discount = await Discount.findByIdAndUpdate(req.params.id, { $set: data }, { new: true, runValidators: true });
  } catch (err) {
    if (isDuplicateKeyError(err, 'code')) return next(new AppError('A discount with this code already exists.', 409));
    throw err;
  }

  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }

  try {
    if (discount.tagadaPromotionId) {
      const client = await getTagadaClient();
      await tagada(client.promotions.update(discount.tagadaPromotionId, { active: providerActive(discount) }), 'tagada.promotions.update');
    } else {
      await createProviderPromotion(discount);
    }
  } catch (err: any) {
    console.error(`[TagadaPay] Failed to sync discount ${discount.code}: ${err?.message}`);
  }

  res.status(200).json({ success: true, data: { discount } });
});

// DELETE /api/admin/discount/:id
export const deleteDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.findByIdAndDelete(req.params.id);

  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }

  if (discount.tagadaPromotionId) {
    try {
      const client = await getTagadaClient();
      if (discount.tagadaPromotionCodeId) {
        await tagada(client.promotionCodes.del(discount.tagadaPromotionCodeId), 'tagada.promotionCodes.del');
      }
      await tagada(client.promotions.del(discount.tagadaPromotionId), 'tagada.promotions.del');
    } catch (err: any) {
      console.error(`[TagadaPay] Failed to delete discount ${discount.code}: ${err?.message}`);
    }
  }

  res.status(204).json({ success: true, data: null });
});
