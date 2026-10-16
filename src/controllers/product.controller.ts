import { Request, Response, NextFunction } from 'express';
import Product from '../models/product.model';
import Collection from '../models/collection.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { uploadImageBuffer, updateImageAltText } from '../utils/cloudinary';
import { buildQueryFromRules, escapeRegex } from '../utils/collectionUtils';
import { cacheGet, cacheSet, cacheKey, cacheIndexAdd, TTL } from '../utils/cache';
import { triggerStorefrontRebuild } from '../utils/rebuildStorefront';
import { AuthenticatedRequest } from '../middleware/auth';
import { isStaffRole } from '../config/roles';
import { sanitizeProductHtmlFields } from '../utils/sanitizeHtml';
import { slugify } from '../utils/slug';

/**
 * Fields never sent to anonymous / customer callers. Each was checked against
 * Client/src (storefront) usage before exclusion. stockQuantity / variants.stockQty
 * are kept because the cart and product page use them to cap quantities.
 */
export const PUBLIC_PRODUCT_EXCLUDE = [
  'costPerItem',
  'variants.costPerItem',
  'lowStockThreshold',
  'tagadaSync',
  'pendingBatchDocs',
  'hsCode',
  'slugHistory',
  'barcode',
  'images.cloudinarySync',
  'variants.tagadaUpdatedAt',
  '__v',
];
export const PUBLIC_PRODUCT_PROJECTION = PUBLIC_PRODUCT_EXCLUDE.map((f) => `-${f}`).join(' ');

/** Remove internal fields from an already-materialised product object (defence in depth). */
const stripInternalProductFields = (p: any) => {
  if (!p || typeof p !== 'object') return p;
  delete p.costPerItem;
  delete p.lowStockThreshold;
  delete p.tagadaSync;
  delete p.pendingBatchDocs;
  delete p.hsCode;
  delete p.slugHistory;
  delete p.barcode;
  delete p.__v;
  if (Array.isArray(p.images)) p.images.forEach((img: any) => img && delete img.cloudinarySync);
  if (Array.isArray(p.variants)) {
    p.variants.forEach((v: any) => {
      if (v) {
        delete v.costPerItem;
        delete v.tagadaUpdatedAt;
      }
    });
  }
  return p;
};

const qStr = (v: unknown, max = 100): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};

const clampInt = (v: unknown, def: number, min: number, max: number): number => {
  const n = parseInt(typeof v === 'string' ? v : '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/** "This URL handle is already used by …" when another product has the slug, else null. */
const slugTakenMessage = async (slug: string, exceptId?: string): Promise<string | null> => {
  const filter: any = { slug };
  if (exceptId) filter._id = { $ne: exceptId };
  const other: any = await Product.findOne(filter).select('name').lean();
  return other ? `This URL handle is already used by "${other.name}". Please choose a different one.` : null;
};

export const getPublicCollections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const CACHE_KEY = 'public:collections';
  const cached = await cacheGet(CACHE_KEY);
  if (cached) return res.status(200).json(cached);

  const collections = await Collection.find({ status: 'active' })
    .sort({ sortOrder: 1, createdAt: -1 })
    .select('name slug description bannerImage productSort seo')
    .lean();
  
  const payload = {
    success: true,
    results: collections.length,
    data: collections,
  };
  await cacheSet(CACHE_KEY, payload, TTL.PUBLIC_CONTENT);
  res.status(200).json(payload);
});


export const getAllProducts = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const isStaff = !!req.user && isStaffRole(req.user.role);

  // Normalise + whitelist query params (bounded cache keys, no type confusion)
  const q = {
    category: qStr(req.query.category),
    availability: qStr(req.query.availability, 20),
    status: isStaff ? qStr(req.query.status, 20) : undefined,
    tag: qStr(req.query.tag),
    collection: qStr(req.query.collection),
    search: qStr(req.query.search),
    sort: qStr(req.query.sort, 40),
    page: clampInt(req.query.page, 1, 1, 1000),
    limit: clampInt(req.query.limit, 50, 1, isStaff ? 1000 : 100),
  };

  // Staff responses include drafts + internal fields: cached under their own key prefix
  // (never served to public callers) for a short TTL. Every 'products:list*' clear covers both.
  const key = cacheKey(isStaff ? 'products:list:staff' : 'products:list', q as Record<string, unknown>);
  const cached = await cacheGet(key);
  if (cached) {
    return res.status(200).json(cached);
  }

  const queryObj: any = {};

  if (q.category && q.category !== 'All Products') {
    queryObj.researchCategory = q.category;
  }

  if (q.availability) {
    if (q.availability === 'In Stock') {
      queryObj.inStock = true;
    } else if (q.availability === 'Out of Stock') {
      queryObj.inStock = false;
    }
  }

  if (isStaff) {
    if (q.status && q.status !== 'all') {
      queryObj.publishStatus = q.status;
    }
  } else {
    // Public callers only ever see active products
    queryObj.publishStatus = 'active';
  }

  // 4) Tag filter
  if (q.tag) {
    queryObj.tags = { $in: [q.tag] };
  }

  // 5) Collection filter — find product IDs in that collection or build query if automated
  if (q.collection && q.collection !== 'all' && q.collection !== 'all-products') {
    const colSlugOrId = q.collection;
    let col;
    if (colSlugOrId.match(/^[0-9a-fA-F]{24}$/)) {
        col = await Collection.findById(colSlugOrId).select('products type rules ruleRelation');
    } else {
        col = await Collection.findOne({ slug: colSlugOrId }).select('products type rules ruleRelation');
    }
    
    if (col) {
      if (col.type === 'automated') {
         const ruleQuery = buildQueryFromRules(col.rules, col.ruleRelation);
         Object.assign(queryObj, ruleQuery);
      } else {
         if (col.products && col.products.length > 0) {
           // Instead of assigning to _id directly which might override existing,
           // we should merge with $in if needed, or simply assign if not present
           queryObj._id = { ...queryObj._id, $in: col.products };
         } else {
           // Collection has no products, return empty results
           queryObj._id = { $in: [] };
         }
      }
    } else {
      // Collection not found, return empty results
      queryObj._id = { $in: [] };
    }
  }

  // 6) Search query
  if (q.search) {
    const safe = escapeRegex(q.search);
    // Match what the user sees/types (name, SKU, slug) — not the long description, where a
    // substring hits unrelated products ("reta" in "secretagogue", "BPC" in a blend's ingredients)
    queryObj.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { sku: { $regex: safe, $options: 'i' } },
      { 'variants.sku': { $regex: safe, $options: 'i' } },
      { slug: { $regex: safe, $options: 'i' } },
    ];
  }

  // Build query
  let query: any = Product.find(queryObj);
  if (!isStaff) {
    query = query.select(PUBLIC_PRODUCT_PROJECTION);
  }

  // 7) Sorting — always ends with a unique tie-breaker (_id). Many products share the same
  // rating/price, and without it MongoDB may order ties differently on each page: with skip/limit
  // some products appeared on two pages and others on none (e.g. 14 of 28 shown at 10 per page).
  const SORTS: Record<string, Record<string, 1 | -1>> = {
    'Price: Low to High': { price: 1 }, 'Price, low to high': { price: 1 },
    'Price: High to Low': { price: -1 }, 'Price, high to low': { price: -1 },
    'Newest': { createdAt: -1 }, 'Date, new to old': { createdAt: -1 },
    'Date, old to new': { createdAt: 1 },
    'Alphabetically, A-Z': { name: 1 },
    'Alphabetically, Z-A': { name: -1 },
  };
  query = query.sort({ ...((q.sort && SORTS[q.sort]) || { rating: -1 }), _id: 1 });

  // 8) Pagination & Limit
  const page = q.page;
  const limit = q.limit;
  const skip = (page - 1) * limit;

  const total = await Product.countDocuments(queryObj);

  query = query.skip(skip).limit(limit);

  query = query.populate('reviews');
  const productsResult = await query;

  const products = productsResult.map((prod: any) => {
    const p = prod.toObject ? prod.toObject() : prod;
    if (p.reviews && p.reviews.length > 0) {
      p.ratingCount = p.reviews.length;
      p.reviewsCount = p.reviews.length;
      const sum = p.reviews.reduce((acc: number, r: any) => acc + (r.rating || 0), 0);
      p.rating = Number((sum / p.reviews.length).toFixed(1));
    } else {
      p.ratingCount = 0;
      p.reviewsCount = 0;
      p.rating = 0;
    }
    delete p.reviews;
    return isStaff ? p : stripInternalProductFields(p);
  });

  const payload = {
    success: true,
    results: products.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: {
      products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    },
  };

  await cacheSet(key, payload, isStaff ? TTL.STAFF_LIST : TTL.PRODUCTS_LIST);

  res.status(200).json(payload);
});

export const getProductById = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const idOrSlug = String(req.params.id || '');
  const isStaff = !!req.user && isStaffRole(req.user.role);

  if (!idOrSlug || idOrSlug.length > 200) {
    return next(new AppError('No product found with that ID or slug', 404));
  }

  // Check cache first (public responses only)
  const key = `products:detail:${idOrSlug.toLowerCase()}`;
  if (!isStaff) {
    const cached = await cacheGet(key);
    if (cached) {
      return res.status(200).json(cached);
    }
  }

  // Public callers: active products only, internal fields projected out
  const findOne = (filter: Record<string, unknown>) => {
    let query: any = Product.findOne(isStaff ? filter : { ...filter, publishStatus: 'active' });
    if (!isStaff) query = query.select(PUBLIC_PRODUCT_PROJECTION);
    return query
      .populate('currentBatchId')
      .populate('variants.currentBatchId')
      .populate('reviews');
  };

  let product: any;

  if (/^[0-9a-fA-F]{24}$/.test(idOrSlug)) {
    // ObjectId
    product = await findOne({ _id: idOrSlug });
  } else if (/^\d+$/.test(idOrSlug)) {
    // Numeric legacy id
    product = await findOne({ id: parseInt(idOrSlug, 10) });
  }

  // Try slug
  if (!product) {
    product = await findOne({ slug: idOrSlug });
  }

  if (!product) {
    return next(new AppError('No product found with that ID or slug', 404));
  }

  const productObj: any = product.toObject();

  // Alias currentBatchId -> currentBatch (root level, for backward compat)
  if (productObj.currentBatchId) {
    productObj.currentBatch = productObj.currentBatchId;
    delete productObj.currentBatchId;
  }

  // Alias variants[].currentBatchId -> variants[].currentBatch
  if (productObj.variants) {
    productObj.variants = productObj.variants.map((v: any) => {
      if (v.currentBatchId) {
        v.currentBatch = v.currentBatchId;
        delete v.currentBatchId;
      }
      return v;
    });
  }

  // Find and attach associated manual collections
  const collections = await Collection.find({ products: product._id }).select('_id name type');
  productObj.collections = collections.map(c => c._id);
  productObj.collectionObjects = collections;

  // Compute dynamic reviews
  if (productObj.reviews && productObj.reviews.length > 0) {
    productObj.ratingCount = productObj.reviews.length;
    productObj.reviewsCount = productObj.reviews.length;
    const sum = productObj.reviews.reduce((acc: number, r: any) => acc + (r.rating || 0), 0);
    productObj.rating = Number((sum / productObj.reviews.length).toFixed(1));
  } else {
    productObj.ratingCount = 0;
    productObj.reviewsCount = 0;
    productObj.rating = 0;
  }
  delete productObj.reviews;
  if (!isStaff) stripInternalProductFields(productObj);

  const payload = {
    success: true,
    data: { product: productObj },
  };

  // Cache the (public) detail response, indexed by product id so a change to this product
  // clears only its own entries (see storefrontRebuildHooks)
  if (!isStaff) {
    await cacheSet(key, payload, TTL.PRODUCT_DETAIL);
    await cacheIndexAdd(`products:detail-index:${product._id}`, key, TTL.PRODUCT_DETAIL);
  }

  res.status(200).json(payload);
});


const calculateInStock = (productData: any): boolean => {
  let totalStock = 0;
  if (productData.variants && Array.isArray(productData.variants) && productData.variants.length > 0) {
    totalStock = productData.variants.reduce((sum: number, v: any) => sum + (parseInt(v.stockQty) || 0), 0);
  } else {
    totalStock = parseInt(productData.stockQuantity) || 0;
  }
  
  if (productData.inventoryPolicy === 'continue' || productData.continueSellingWhenOutOfStock === true) {
    return true;
  }
  
  return totalStock > 0;
};

export const createProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { collections, tags, tag, ...productData } = req.body;
  sanitizeProductHtmlFields(productData);

  // Merge tags: prefer tags[] array; fall back to splitting tag string
  if (tags && Array.isArray(tags)) {
    productData.tags = tags;
  } else if (tag && typeof tag === 'string') {
    productData.tags = tag.split(',').map((t: string) => t.trim()).filter(Boolean);
    productData.tag = tag;
  }

  // URL handle: the one provided, else generated from the name; must be valid and unique
  productData.slug = slugify(productData.slug || productData.name);
  if (!productData.slug) {
    return next(new AppError('A URL handle (or a name to generate it from) is required.', 400));
  }
  const takenOnCreate = await slugTakenMessage(productData.slug);
  if (takenOnCreate) return next(new AppError(takenOnCreate, 400));

  // Set publishStatus from published if not provided; keep the legacy flag in sync with it
  if (!productData.publishStatus) {
    productData.publishStatus = productData.published !== false ? 'active' : 'draft';
  }
  productData.published = productData.publishStatus === 'active';

  // Map variants to restore currentBatchId if currentBatch is passed
  if (productData.variants && Array.isArray(productData.variants)) {
    productData.variants = productData.variants.map((v: any) => {
      if (v.currentBatch && typeof v.currentBatch === 'object') {
        v.currentBatchId = v.currentBatch._id || v.currentBatch;
      } else if (v.currentBatch) {
        v.currentBatchId = v.currentBatch;
      }
      if (v.currentBatchId === '') {
        v.currentBatchId = null;
      }
      return v;
    });
  }

  // Ensure the first variant matches the root stockQuantity
  if (productData.variants && productData.variants.length === 1 && productData.stockQuantity !== undefined) {
     productData.variants[0].stockQty = parseInt(productData.stockQuantity as string, 10) || 0;
  }
  
  productData.inStock = calculateInStock(productData);

  const newProduct = await Product.create(productData);

  // Sync manual collections
  if (collections && Array.isArray(collections)) {
    await Collection.updateMany(
      { _id: { $in: collections }, type: 'manual' },
      { $addToSet: { products: newProduct._id } }
    );
  }

  // Invalidate product list cache
  const { cacheDel } = await import('../utils/cache');
  await cacheDel('products:list*');
  
  // Trigger storefront rebuild in background
  triggerStorefrontRebuild();

  res.status(201).json({
    success: true,
    data: { product: newProduct },
  });
});

export const updateProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { collections, tags, tag, ...productData } = req.body;
  sanitizeProductHtmlFields(productData);

  if (tags && Array.isArray(tags)) {
    productData.tags = tags;
  } else if (tag && typeof tag === 'string') {
    productData.tags = tag.split(',').map((t: string) => t.trim()).filter(Boolean);
    productData.tag = tag;
  }
  // URL handle: changes ONLY when explicitly sent — never derived from a name change.
  // An empty value keeps the current URL.
  if (Object.prototype.hasOwnProperty.call(productData, 'slug')) {
    const raw = productData.slug;
    if (raw == null || String(raw).trim() === '') {
      delete productData.slug;
    } else {
      const nextSlug = slugify(raw);
      if (!nextSlug) {
        return next(new AppError('URL handle must contain letters or numbers (e.g. "retatrutide-5mg").', 400));
      }
      const taken = await slugTakenMessage(nextSlug, req.params.id);
      if (taken) return next(new AppError(taken, 400));
      productData.slug = nextSlug;
    }
  }

  if (productData.published !== undefined && !productData.publishStatus) {
    productData.publishStatus = productData.published ? 'active' : 'draft';
  }
  // publishStatus is the source of truth (storefront filter); keep the legacy flag in sync
  if (productData.publishStatus) {
    productData.published = productData.publishStatus === 'active';
  }

  // Map variants to restore currentBatchId if currentBatch is passed
  if (productData.variants && Array.isArray(productData.variants)) {
    productData.variants = productData.variants.map((v: any) => {
      if (v.currentBatch && typeof v.currentBatch === 'object') {
        v.currentBatchId = v.currentBatch._id || v.currentBatch;
      } else if (v.currentBatch) {
        v.currentBatchId = v.currentBatch;
      }
      if (v.currentBatchId === '') {
        v.currentBatchId = null;
      }
      return v;
    });
  } else if (productData.stockQuantity !== undefined) {
    // If variants weren't explicitly passed but stockQuantity was (e.g. from Inventory quick edit),
    // sync it to the first variant if we can.
    const existingProduct = await Product.findById(req.params.id);
    if (existingProduct && existingProduct.variants && existingProduct.variants.length > 0) {
      productData.variants = existingProduct.variants.map((v: any, index: number) => {
        if (index === 0) {
          v.stockQty = parseInt(productData.stockQuantity as string, 10) || 0;
        }
        return v;
      });
    }
  }

  // Double check if variants are passed, ensure the first variant matches the root stockQuantity
  if (productData.variants && productData.variants.length === 1 && productData.stockQuantity !== undefined) {
     productData.variants[0].stockQty = parseInt(productData.stockQuantity as string, 10) || 0;
  }
  
  productData.inStock = calculateInStock(productData);

  const updatedProduct = await Product.findByIdAndUpdate(req.params.id, productData, {
    new: true,
    runValidators: true,
  });

  if (!updatedProduct) {
    return next(new AppError('No product found with that ID', 404));
  }

  // Sync manual collections
  if (collections && Array.isArray(collections)) {
    await Collection.updateMany(
      { type: 'manual', products: updatedProduct._id },
      { $pull: { products: updatedProduct._id } }
    );
    await Collection.updateMany(
      { _id: { $in: collections }, type: 'manual' },
      { $addToSet: { products: updatedProduct._id } }
    );
  }

  // Invalidate this product's cached detail entries (every slug/id variant, incl. a previous
  // slug) and all lists. Detail responses never embed other products.
  const { cacheDel, cacheDelIndexed } = await import('../utils/cache');
  await Promise.all([
    cacheDelIndexed(`products:detail-index:${updatedProduct._id}`),
    cacheDel('products:list*'),
  ]);
  
  // Trigger storefront rebuild in background
  triggerStorefrontRebuild();

  res.status(200).json({
    success: true,
    data: { product: updatedProduct },
  });
});


/**
 * "Delete" archives the product instead of removing it: orders, reviews, COA batches and old
 * links reference it, so it is hidden from the store (publishStatus 'archived') and kept in the
 * database. Restore it by setting Status back to Active in the product form.
 */
export const deleteProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const deletedProduct = await Product.findByIdAndUpdate(
    req.params.id,
    { $set: { publishStatus: 'archived', published: false } },
    { new: true }
  );

  if (!deletedProduct) {
    return next(new AppError('No product found with that ID', 404));
  }

  // Invalidate this product's cached detail entries and all lists
  const { cacheDel, cacheDelIndexed } = await import('../utils/cache');
  await Promise.all([
    cacheDelIndexed(`products:detail-index:${deletedProduct._id}`),
    cacheDel('products:list*'),
  ]);
  
  // Trigger storefront rebuild in background
  triggerStorefrontRebuild();

  res.status(200).json({ success: true, message: 'Product archived', data: { product: deletedProduct } });
});


export const uploadProductImage = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) {
    return next(new AppError('No file uploaded', 400));
  }
  
  const result = await uploadImageBuffer(req.file.buffer, 'products');
  
  res.status(200).json({
    success: true,
    data: {
      secure_url: result.secure_url,
      public_id: result.public_id,
      asset_id: result.asset_id,
      width: result.width,
      height: result.height,
      format: result.format
    }
  });
});

export const updateMediaAltText = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { productId, mediaId } = req.params;
  const { altText } = req.body;

  if (typeof altText !== 'string') {
    return next(new AppError('altText must be a string', 400));
  }

  const trimmedAlt = altText.trim().substring(0, 160);

  const product = await Product.findById(productId);
  if (!product) {
    return next(new AppError('Product not found', 404));
  }

  // Find the specific image in the array
  const image = (product.images as any).id(mediaId);
  if (!image) {
    return next(new AppError('Media not found on this product', 404));
  }

  // Update locally first
  image.altText = trimmedAlt;
  image.alt = trimmedAlt; // For backwards compatibility if any legacy code uses it directly

  let syncError: string | null = null;
  let syncedAt: Date | undefined;

  // If publicId is present, sync with Cloudinary
  if (image.publicId) {
    try {
      await updateImageAltText(image.publicId, trimmedAlt);
      syncedAt = new Date();
    } catch (err: any) {
      syncError = err.message || 'Failed to sync with Cloudinary';
      console.error('Cloudinary sync failed:', err);
    }
  }

  image.cloudinarySync = {
    altTextSyncedAt: syncedAt,
    lastSyncError: syncError || undefined
  };

  await product.save();

  res.status(200).json({
    success: true,
    data: image
  });
});
