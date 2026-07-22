import { Request, Response, NextFunction } from 'express';
import Product from '../models/product.model';
import Collection from '../models/collection.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { uploadImageBuffer } from '../utils/cloudinary';
import { buildQueryFromRules } from '../utils/collectionUtils';

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

export const getPublicCollections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const collections = await Collection.find({ status: 'active' })
    .sort({ sortOrder: 1, createdAt: -1 })
    .select('name slug description bannerImage');
  
  res.status(200).json({
    success: true,
    results: collections.length,
    data: collections,
  });
});


export const getAllProducts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const queryObj: any = {};

  if (req.query.category && req.query.category !== 'All Products') {
    queryObj.researchCategory = req.query.category;
  }

  if (req.query.availability) {
    if (req.query.availability === 'In Stock') {
      queryObj.inStock = true;
    } else if (req.query.availability === 'Out of Stock') {
      queryObj.inStock = false;
    }
  }


  if (req.query.status && req.query.status !== 'all') {
    queryObj.publishStatus = req.query.status;
  }

  // 4) Tag filter
  if (req.query.tag) {
    queryObj.tags = { $in: [req.query.tag] };
  }

  // 5) Collection filter — find product IDs in that collection or build query if automated
  if (req.query.collection) {
    const colSlugOrId = req.query.collection as string;
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
  if (req.query.search) {
    queryObj.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { description: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  // Build query
  let query = Product.find(queryObj);

  // 7) Sorting
  if (req.query.sort) {
    const sortType = req.query.sort as string;
    if (sortType === 'Price: Low to High' || sortType === 'Price, low to high') {
      query = query.sort({ price: 1 });
    } else if (sortType === 'Price: High to Low' || sortType === 'Price, high to low') {
      query = query.sort({ price: -1 });
    } else if (sortType === 'Newest' || sortType === 'Date, new to old') {
      query = query.sort({ createdAt: -1 });
    } else if (sortType === 'Date, old to new') {
      query = query.sort({ createdAt: 1 });
    } else if (sortType === 'Alphabetically, A-Z') {
      query = query.sort({ name: 1 });
    } else if (sortType === 'Alphabetically, Z-A') {
      query = query.sort({ name: -1 });
    } else {
      query = query.sort({ rating: -1 });
    }
  } else {
    query = query.sort({ rating: -1 });
  }

  // 8) Limit
  if (req.query.limit) {
    const limit = parseInt(req.query.limit as string, 10);
    if (!isNaN(limit)) {
      query = query.limit(limit);
    }
  }

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
    return p;
  });

  res.status(200).json({
    success: true,
    results: products.length,
    data: { products },
  });
});

export const getProductById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const idOrSlug = req.params.id;
  let product: any;

  // Try ObjectId first
  if (idOrSlug.match(/^[0-9a-fA-F]{24}$/)) {
    product = await Product.findById(idOrSlug)
      .populate('currentBatchId')
      .populate('variants.currentBatchId')
      .populate('reviews');
  }

  // Try numeric id
  if (!product) {
    const numericId = parseInt(idOrSlug, 10);
    if (!isNaN(numericId)) {
      product = await Product.findOne({ id: numericId })
        .populate('currentBatchId')
        .populate('variants.currentBatchId')
        .populate('reviews');
    }
  }

  // Try slug
  if (!product) {
    product = await Product.findOne({ slug: idOrSlug })
      .populate('currentBatchId')
      .populate('variants.currentBatchId')
      .populate('reviews');
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

  res.status(200).json({
    success: true,
    data: { product: productObj },
  });
});


export const createProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { collections, tags, tag, ...productData } = req.body;

  // Merge tags: prefer tags[] array; fall back to splitting tag string
  if (tags && Array.isArray(tags)) {
    productData.tags = tags;
  } else if (tag && typeof tag === 'string') {
    productData.tags = tag.split(',').map((t: string) => t.trim()).filter(Boolean);
    productData.tag = tag;
  }

  // Auto-generate slug if not provided
  if (!productData.slug && productData.name) {
    productData.slug = slugify(productData.name);
  }

  // Set publishStatus from published if not provided
  if (!productData.publishStatus) {
    productData.publishStatus = productData.published !== false ? 'active' : 'draft';
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
  }

  const newProduct = await Product.create(productData);

  // Sync manual collections
  if (collections && Array.isArray(collections)) {
    await Collection.updateMany(
      { _id: { $in: collections }, type: 'manual' },
      { $addToSet: { products: newProduct._id } }
    );
  }

  res.status(201).json({
    success: true,
    data: { product: newProduct },
  });
});

export const updateProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { collections, tags, tag, ...productData } = req.body;

  if (tags && Array.isArray(tags)) {
    productData.tags = tags;
  } else if (tag && typeof tag === 'string') {
    productData.tags = tag.split(',').map((t: string) => t.trim()).filter(Boolean);
    productData.tag = tag;
  }
  if (productData.name && !productData.slug) {
    productData.slug = slugify(productData.name);
  }

  if (productData.published !== undefined && !productData.publishStatus) {
    productData.publishStatus = productData.published ? 'active' : 'draft';
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
  }

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

  res.status(200).json({
    success: true,
    data: { product: updatedProduct },
  });
});


export const deleteProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const deletedProduct = await Product.findByIdAndDelete(req.params.id);

  if (!deletedProduct) {
    return next(new AppError('No product found with that ID', 404));
  }

  res.status(204).json({ success: true, data: null });
});


export const deleteAllProducts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  await Product.deleteMany({});
  res.status(200).json({
    success: true,
    message: 'All products have been deleted successfully.'
  });
});

export const uploadProductImage = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }
  
  const result = await uploadImageBuffer(req.file.buffer, 'products');
  
  res.status(200).json({
    success: true,
    data: {
      secure_url: result.secure_url
    }
  });
});
