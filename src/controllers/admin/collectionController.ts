import { Request, Response, NextFunction } from 'express';
import Collection from '../../models/collection.model';
import Product from '../../models/product.model';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
import { cacheDel } from '../../utils/cache';
import { buildQueryFromRules } from '../../utils/collectionUtils';

const slugify = (text: string) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w\-]+/g, '') // Remove all non-word chars
    .replace(/\-\-+/g, '-'); // Replace multiple - with single -
};


// GET /api/admin/collection
export const getCollections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const collections = await Collection.find().sort({ sortOrder: 1, createdAt: -1 });
  
  // Resolve product counts dynamically
  const collectionsWithCount = await Promise.all(
    collections.map(async (col) => {
      let productCount = 0;
      if (col.slug === 'all') {
        productCount = await Product.countDocuments({ publishStatus: 'active' });
      } else if (col.type === 'automated') {
        const query = buildQueryFromRules(col.rules, col.ruleRelation);
        productCount = await Product.countDocuments(query);
      } else {
        productCount = col.products ? col.products.length : 0;
      }
      
      return {
        ...col.toObject(),
        productCount
      };
    })
  );

  res.status(200).json({
    success: true,
    results: collectionsWithCount.length,
    data: collectionsWithCount,
  });
});

// GET /api/admin/collection/:id
export const getCollectionById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const col = await Collection.findById(id);

  if (!col) {
    return next(new AppError('No collection found with that ID', 404));
  }

  let productsList: any[] = [];
  if (col.type === 'automated') {
    const query = buildQueryFromRules(col.rules, col.ruleRelation);
    productsList = await Product.find(query).sort({ name: 1 });
  } else {
    // Populate products and preserve manual collection sequence
    const populated = await Collection.findById(id).populate('products');
    const rawProducts = (populated ? populated.products : []) as any[];
    if (col.products && col.products.length > 0) {
      const orderMap = new Map(col.products.map((pid: any, index: number) => [String(pid), index]));
      rawProducts.sort((a: any, b: any) => {
        const idxA = orderMap.has(String(a._id)) ? orderMap.get(String(a._id))! : 999999;
        const idxB = orderMap.has(String(b._id)) ? orderMap.get(String(b._id))! : 999999;
        return idxA - idxB;
      });
    }
    productsList = rawProducts;
  }

  res.status(200).json({
    success: true,
    data: {
      collection: col,
      products: productsList,
    },
  });
});

// POST /api/admin/collection
export const createCollection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const {
    name,
    slug,
    description,
    bannerImage,
    status,
    type,
    ruleRelation,
    rules,
    sortOrder,
    productSort,
    displayOptions,
    products,
    seo
  } = req.body;

  if (!name) {
    return next(new AppError('A collection must have a name', 400));
  }

  const generatedSlug = slug ? slugify(slug) : slugify(name);

  // Check unique slug
  const existing = await Collection.findOne({ slug: generatedSlug });
  if (existing) {
    return next(new AppError(`Collection slug "${generatedSlug}" is already in use.`, 400));
  }

  const newCol = await Collection.create({
    name,
    slug: generatedSlug,
    description,
    bannerImage,
    status: status || 'active',
    type: type || 'manual',
    ruleRelation: ruleRelation || 'all',
    rules: rules || [],
    sortOrder: sortOrder || 0,
    productSort: productSort || 'alpha-asc',
    displayOptions: displayOptions || { showFaqBlock: false },
    products: products || [],
    seo: seo || {},
  });

  await cacheDel('products:list*');
  await cacheDel('products:detail*');

  res.status(201).json({
    success: true,
    data: newCol,
  });
});

// PATCH /api/admin/collection/:id
export const updateCollection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const col = await Collection.findById(id);

  if (!col) {
    return next(new AppError('No collection found with that ID', 404));
  }

  const {
    name,
    slug,
    description,
    bannerImage,
    status,
    type,
    ruleRelation,
    rules,
    sortOrder,
    productSort,
    displayOptions,
    products,
    seo
  } = req.body;

  if (name !== undefined) col.name = name;
  if (slug !== undefined) {
    // Protect the system 'all' collection slug
    if (col.slug === 'all' && slug !== 'all') {
      return next(new AppError('The "all" collection slug cannot be modified.', 400));
    }
    const nextSlug = slugify(slug);
    if (nextSlug !== col.slug) {
      const existing = await Collection.findOne({ slug: nextSlug });
      if (existing) {
        return next(new AppError(`Collection slug "${nextSlug}" is already in use.`, 400));
      }
      col.slug = nextSlug;
    }
  } else if (name !== undefined && !col.slug) {
    col.slug = slugify(name);
  }

  if (description !== undefined) col.description = description;
  if (bannerImage !== undefined) col.bannerImage = bannerImage;
  if (status !== undefined) col.status = status;
  if (type !== undefined) col.type = type;
  if (ruleRelation !== undefined) col.ruleRelation = ruleRelation;
  if (rules !== undefined) col.rules = rules;
  if (sortOrder !== undefined) col.sortOrder = sortOrder;
  if (productSort !== undefined) col.productSort = productSort;
  if (displayOptions !== undefined) col.displayOptions = displayOptions;
  if (products !== undefined) col.products = products;
  if (seo !== undefined) col.seo = seo;

  await col.save();

  await cacheDel('products:list*');
  await cacheDel('products:detail*');

  res.status(200).json({
    success: true,
    data: col,
  });
});

// DELETE /api/admin/collection/:id
export const deleteCollection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const col = await Collection.findById(id);

  if (!col) {
    return next(new AppError('No collection found with that ID', 404));
  }

  if (col.slug === 'all') {
    return next(new AppError('The "All Products" system collection cannot be deleted.', 400));
  }

  await Collection.findByIdAndDelete(id);

  await cacheDel('products:list*');
  await cacheDel('products:detail*');

  res.status(204).json({
    success: true,
    data: null,
  });
});
