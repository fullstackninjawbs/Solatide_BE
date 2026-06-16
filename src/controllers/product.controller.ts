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
    if (sortType === 'Price: Low to High') {
      query = query.sort({ price: 1 });
    } else if (sortType === 'Price: High to Low') {
      query = query.sort({ price: -1 });
    } else if (sortType === 'Newest') {
      query = query.sort({ createdAt: -1 });
    } else if (sortType === 'Best Selling') {
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
  const product = await Product.findById(req.params.id);

  if (!product) {
    return next(new AppError('No product found with that ID', 404));
  }

  res.status(200).json({
    success: true,
    data: {
      product,
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
