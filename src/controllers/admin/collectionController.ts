import { Request, Response, NextFunction } from 'express';
import Collection from '../../models/collection.model';
import Product from '../../models/product.model';
import catchAsync from '../../utils/catchAsync';
import AppError from '../../utils/appError';
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
      if (col.type === 'automated') {
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
    // Populate products
    const populated = await Collection.findById(id).populate({
      path: 'products',
      options: { sort: { name: 1 } }
    });
    productsList = populated ? populated.products : [];
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
    displayOptions,
    products
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
    displayOptions: displayOptions || { showFaqBlock: false },
    products: products || [],
  });

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
    displayOptions,
    products
  } = req.body;

  if (name !== undefined) col.name = name;
  if (slug !== undefined) {
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
  if (displayOptions !== undefined) col.displayOptions = displayOptions;
  if (products !== undefined) col.products = products;

  await col.save();

  res.status(200).json({
    success: true,
    data: col,
  });
});

// DELETE /api/admin/collection/:id
export const deleteCollection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const col = await Collection.findByIdAndDelete(id);

  if (!col) {
    return next(new AppError('No collection found with that ID', 404));
  }

  res.status(204).json({
    success: true,
    data: null,
  });
});
