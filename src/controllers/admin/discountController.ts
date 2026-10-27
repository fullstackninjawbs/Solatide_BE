import { Request, Response, NextFunction } from 'express';
import Discount from '../../models/Discount';
import Product from '../../models/product.model';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import { escapeRegExp } from '../../domain/escapeRegExp';
import { pickDiscountFields } from '../../domain/discountEligibility';
import { displayStatus } from '../../domain/discountEngine';
import { isDuplicateKeyError } from '../../services/orders/orderNumber';

/**
 * Admin → Discounts. Discounts live in the hub only: our checkout applies them
 * (services/discounts/discountService.ts, rules in domain/discountEngine.ts). Uses are counted
 * when a bank transfer order is placed, or when an order created in Admin is paid (onOrderPaid).
 */

/** Discount as the hub shows it: computed status + the products named in its rules. */
async function withDetails(discounts: any[]): Promise<any[]> {
  const productIds = new Set<string>();
  for (const d of discounts) for (const r of d.rules || []) for (const p of r.products || []) productIds.add(String(p));
  const products: any[] = productIds.size
    ? await Product.find({ _id: { $in: [...productIds] } }).select('name imageUrl images').lean()
    : [];
  const byId = new Map(products.map((p) => [String(p._id), { _id: p._id, name: p.name, imageUrl: p.imageUrl || p.images?.[0]?.url || '' }]));
  return discounts.map((d) => ({
    ...d,
    displayStatus: displayStatus(d),
    rules: (d.rules || []).map((r: any) => ({
      ...r,
      productDetails: (r.products || []).map((p: any) => byId.get(String(p)) || { _id: p, name: '(deleted product)', imageUrl: '' }),
    })),
  }));
}

// GET /api/admin/discount
export const getDiscounts = catchAsync(async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status as string;
  const filter: any = {};
  if (search) {
    filter.code = { $regex: escapeRegExp(search, 100), $options: 'i' };
  }
  const now = new Date();
  // Filters match the status shown in the list (dates and usage limits included)
  if (status === 'disabled') filter.status = 'disabled';
  else if (status === 'expired') {
    filter.$and = [{ status: { $ne: 'disabled' } }, { $or: [{ status: 'expired' }, { activeTo: { $lt: now } }, { $expr: { $and: [{ $gt: ['$maxUses', 0] }, { $gte: ['$usesSoFar', '$maxUses'] }] } }] }];
  } else if (status === 'scheduled') {
    filter.status = 'active';
    filter.activeFrom = { $gt: now };
  } else if (status === 'active') {
    filter.status = 'active';
    filter.$and = [
      { $or: [{ activeFrom: null }, { activeFrom: { $lte: now } }] },
      { $or: [{ activeTo: null }, { activeTo: { $gte: now } }] },
      { $or: [{ maxUses: { $lte: 0 } }, { maxUses: null }, { $expr: { $lt: ['$usesSoFar', '$maxUses'] } }] },
    ];
  }

  const [discounts, total] = await Promise.all([
    Discount.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Discount.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    data: {
      discounts: await withDetails(discounts),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
});

// GET /api/admin/discount/:id
export const getDiscountById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) return next(new AppError('Discount not found', 404));
  const discount: any = await Discount.findById(req.params.id).lean();
  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }
  const [withInfo] = await withDetails([discount]);
  res.status(200).json({ success: true, data: { discount: withInfo } });
});

/** The same code (any letter case) is one discount at checkout: refuse duplicates. */
async function codeTaken(code: unknown, exceptId?: string): Promise<boolean> {
  if (typeof code !== 'string') return false;
  const filter: any = { code: { $regex: `^${escapeRegExp(code, 64)}$`, $options: 'i' } };
  if (exceptId) filter._id = { $ne: exceptId };
  return !!(await Discount.exists(filter));
}

// POST /api/admin/discount
export const createDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { data, errors } = pickDiscountFields(req.body, { partial: false });
  if (errors.length) return next(new AppError(errors.join('; '), 400));
  if (await codeTaken(data.code)) return next(new AppError('A discount with this code already exists.', 409));

  let discount: any;
  try {
    discount = await Discount.create(data);
  } catch (err) {
    if (isDuplicateKeyError(err, 'code')) return next(new AppError('A discount with this code already exists.', 409));
    throw err;
  }
  const [withInfo] = await withDetails([discount.toObject()]);
  res.status(201).json({ success: true, data: { discount: withInfo } });
});

// PUT /api/admin/discount/:id
export const updateDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) return next(new AppError('Discount not found', 404));
  const { data, errors } = pickDiscountFields(req.body, { partial: true });
  if (errors.length) return next(new AppError(errors.join('; '), 400));
  if (data.code !== undefined && (await codeTaken(data.code, String(req.params.id)))) {
    return next(new AppError('A discount with this code already exists.', 409));
  }

  let discount: any;
  try {
    discount = await Discount.findByIdAndUpdate(req.params.id, { $set: data }, { new: true, runValidators: true }).lean();
  } catch (err) {
    if (isDuplicateKeyError(err, 'code')) return next(new AppError('A discount with this code already exists.', 409));
    throw err;
  }
  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }
  const [withInfo] = await withDetails([discount]);
  res.status(200).json({ success: true, data: { discount: withInfo } });
});

// DELETE /api/admin/discount/:id
export const deleteDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) return next(new AppError('Discount not found', 404));
  const discount = await Discount.findByIdAndDelete(req.params.id);
  if (!discount) {
    return next(new AppError('Discount not found', 404));
  }
  res.status(204).json({ success: true, data: null });
});
