import { Request, Response, NextFunction } from 'express';
import Product from '../models/product.model';
import Collection from '../models/collection.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { uploadImageBuffer } from '../utils/cloudinary';

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');


export const getAllProducts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const queryObj: any = {};

  if (req.query.category && req.query.category !== 'All Products') {
    queryObj.category = req.query.category;
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

  // 5) Collection filter — find product IDs in that collection
  if (req.query.collection) {
    const col = await Collection.findById(req.query.collection).select('products');
    if (col && col.products) {
      queryObj._id = { $in: col.products };
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

  const products = await query;

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
      .populate('variants.currentBatchId');
  }

  // Try numeric id
  if (!product) {
    const numericId = parseInt(idOrSlug, 10);
    if (!isNaN(numericId)) {
      product = await Product.findOne({ id: numericId })
        .populate('currentBatchId')
        .populate('variants.currentBatchId');
    }
  }

  // Try slug
  if (!product) {
    product = await Product.findOne({ slug: idOrSlug })
      .populate('currentBatchId')
      .populate('variants.currentBatchId');
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
