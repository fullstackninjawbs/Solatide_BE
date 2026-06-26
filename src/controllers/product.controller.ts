import { Request, Response, NextFunction } from 'express';
import Product from '../models/product.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';

/**
 * Get all products with flexible search, category filter, availability filter, and sorting.
 */
export const getAllProducts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const queryObj: any = {};

  // 1) Filtering by Category
  if (req.query.category && req.query.category !== 'All Products') {
    queryObj.category = req.query.category;
  }

  // 2) Filtering by Availability
  if (req.query.availability) {
    if (req.query.availability === 'In Stock') {
      queryObj.inStock = true;
    } else if (req.query.availability === 'Out of Stock') {
      queryObj.inStock = false;
    }
  }

  // 3) Search query (case-insensitive keyword match in name or description)
  if (req.query.search) {
    queryObj.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { description: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  // Build the Mongoose Query
  let query = Product.find(queryObj);

  // 4) Sorting
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
      // Default: Best Selling / Featured / Most relevant
      query = query.sort({ rating: -1 });
    }
  } else {
    // Default sorting: Best Selling (Rating descending)
    query = query.sort({ rating: -1 });
  }

  // 5) Limiting results count
  if (req.query.limit) {
    const limit = parseInt(req.query.limit as string, 10);
    if (!isNaN(limit)) {
      query = query.limit(limit);
    }
  }

  // Execute Query
  const products = await query;

  res.status(200).json({
    success: true,
    results: products.length,
    data: {
      products,
    },
  });
});

/**
 * Get details of a single product
 */
export const getProductById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const idOrObjectId = req.params.id;
  let product;

  // Check if it's a valid 24-char hex MongoDB ObjectId
  if (idOrObjectId.match(/^[0-9a-fA-F]{24}$/)) {
    product = await Product.findById(idOrObjectId).populate('currentBatchId');
  } else {
    // Fallback: try querying by custom numeric id field
    const numericId = parseInt(idOrObjectId, 10);
    if (!isNaN(numericId)) {
      product = await Product.findOne({ id: numericId }).populate('currentBatchId');
    }
  }

  if (!product) {
    return next(new AppError('No product found with that ID', 404));
  }

  // Transform currentBatchId to currentBatch for frontend convenience
  const productObj: any = product.toObject();
  if (productObj.currentBatchId) {
    productObj.currentBatch = productObj.currentBatchId;
    delete productObj.currentBatchId;
  }

  res.status(200).json({
    success: true,
    data: {
      product: productObj,
    },
  });
});

/**
 * Create a new product (Admin Only)
 */
export const createProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const newProduct = await Product.create(req.body);

  res.status(201).json({
    success: true,
    data: {
      product: newProduct,
    },
  });
});

/**
 * Update an existing product details (Admin Only)
 */
export const updateProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const updatedProduct = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!updatedProduct) {
    return next(new AppError('No product found with that ID', 404));
  }

  res.status(200).json({
    success: true,
    data: {
      product: updatedProduct,
    },
  });
});

/**
 * Delete a product from catalog (Admin Only)
 */
export const deleteProduct = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const deletedProduct = await Product.findByIdAndDelete(req.params.id);

  if (!deletedProduct) {
    return next(new AppError('No product found with that ID', 404));
  }

  res.status(204).json({
    success: true,
    data: null,
  });
});

/**
 * Delete all products from catalog (Admin Only)
 */
export const deleteAllProducts = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  await Product.deleteMany({});

  res.status(200).json({
    success: true,
    message: 'All products have been deleted successfully.'
  });
});
