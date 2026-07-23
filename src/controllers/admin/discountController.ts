import { Request, Response, NextFunction } from 'express';
import Discount from '../../models/Discount';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import { getTagadaClient } from '../../services/tagadaClient';
import PaymentSettings from '../../models/PaymentSettings';
import config from '../../config';

// GET /api/admin/discount
export const getDiscounts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const search = req.query.search as string;
  const status = req.query.status as string;
  const filter: any = {};
  if (search) {
    filter.code = { $regex: search, $options: 'i' };
  }
  if (status && status !== 'all') {
    filter.status = status;
  }

  const discounts = await Discount.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Discount.countDocuments(filter);

  res.status(200).json({
    success: true,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    data: {
      discounts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    }
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
  
  let tagadaPromotions = [];
  let tagadaCodes = [];
  
  try {
    const promoData = await client.promotions.list({ storeId });
    console.log('--- RAW TAGADA PROMOTIONS RESPONSE ---');
    console.log(JSON.stringify(promoData, null, 2));
    tagadaPromotions = Array.isArray(promoData) ? promoData : (promoData.items || promoData.data || promoData.promotions || []);
    
    const codeData = await client.promotionCodes.list({ storeId });
    console.log('--- RAW TAGADA PROMOTION CODES RESPONSE ---');
    console.log(JSON.stringify(codeData, null, 2));
    tagadaCodes = Array.isArray(codeData) ? codeData : (codeData.items || codeData.data || codeData.promotionCodes || []);
  } catch (err: any) {
    console.error('[TagadaPay] Failed to fetch existing promotions:', err?.response?.data || err.message);
    return next(new AppError('Failed to fetch from Tagada Pay.', 502));
  }
  
  let imported = 0;
  
  for (const promo of tagadaPromotions) {
    // Find associated code if any
    const codeObj = tagadaCodes.find((c: any) => c.promotionId === promo.id);
    
    // Tagada's actual code string might be in codeObj.code, promo.code, or promo.name
    const actualCode = codeObj?.code || promo.code || promo.name;
    
    if (!actualCode) continue;

    // Check if it already exists in our DB
    const exists = await Discount.findOne({ code: actualCode });
    if (!exists) {
      await Discount.create({
        code: actualCode,
        type: promo.discountType === 'percentage' ? 'percent' : 'fixed',
        value: promo.discountValue || 0,
        status: (codeObj ? codeObj.active : true) && promo.enabled ? 'active' : 'disabled',
        tagadaPromotionId: promo.id,
        tagadaPromotionCodeId: codeObj?.id,
        appliesTo: 'all'
      });
      imported++;
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

  res.status(200).json({
    success: true,
    data: { discount }
  });
});

// POST /api/admin/discount
export const createDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.create(req.body);

  try {
    const client = await getTagadaClient();
    const isPercentage = discount.type === 'percent';
    const promo = await client.promotions.create({
      name: discount.code,
      discountType: isPercentage ? 'percentage' : 'fixed_amount',
      discountValue: discount.value,
      active: discount.status === 'active'
    });
    
    let promoCode;
    try {
      promoCode = await client.promotionCodes.create({
        promotion: promo.id,
        code: discount.code
      });
    } catch(err: any) {
      console.error('[TagadaPay] Failed to create promotion code:', err?.response?.data || err.message);
    }
    
    discount.tagadaPromotionId = promo.id;
    if (promoCode) {
      discount.tagadaPromotionCodeId = promoCode.id;
    }
    await discount.save({ validateBeforeSave: false });
  } catch (err: any) {
    console.error('[TagadaPay] Failed to sync new discount:', err?.response?.data || err.message);
  }

  res.status(201).json({
    success: true,
    data: { discount }
  });
});

// PUT /api/admin/discount/:id
export const updateDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const discount = await Discount.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });

  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }

  if (discount.tagadaPromotionId) {
    try {
      const client = await getTagadaClient();
      await client.promotions.update(discount.tagadaPromotionId, {
        active: discount.status === 'active'
      });
    } catch (err: any) {
      console.error('[TagadaPay] Failed to update discount:', err?.response?.data || err.message);
    }
  } else {
    // If it wasn't synced before, try creating it now
    try {
      const client = await getTagadaClient();
      const isPercentage = discount.type === 'percent';
      const promo = await client.promotions.create({
        name: discount.code,
        discountType: isPercentage ? 'percentage' : 'fixed_amount',
        discountValue: discount.value,
        active: discount.status === 'active'
      });
      let promoCode;
      try {
        promoCode = await client.promotionCodes.create({
          promotion: promo.id,
          code: discount.code
        });
      } catch(err: any) {}
      
      discount.tagadaPromotionId = promo.id;
      if (promoCode) discount.tagadaPromotionCodeId = promoCode.id;
      await discount.save({ validateBeforeSave: false });
    } catch (err: any) {
      console.error('[TagadaPay] Failed to sync existing discount:', err?.response?.data || err.message);
    }
  }

  res.status(200).json({
    success: true,
    data: { discount }
  });
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
        await client.promotionCodes.del(discount.tagadaPromotionCodeId);
      }
      await client.promotions.del(discount.tagadaPromotionId);
    } catch (err: any) {
      console.error('[TagadaPay] Failed to delete discount:', err?.response?.data || err.message);
    }
  }

  res.status(204).json({
    success: true,
    data: null
  });
});
