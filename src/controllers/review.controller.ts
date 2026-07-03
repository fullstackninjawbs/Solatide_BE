import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Review from '../models/review.model';
import catchAsync from '../utils/catchAsync';
import AppError from '../utils/appError';
import { uploadImageBuffer, deleteImageByUrl } from '../utils/cloudinary';
import { sendVerificationEmail } from '../services/emailService';
import crypto from 'crypto';
import Product from '../models/product.model';

// @desc    Create a new review
// @route   POST /api/v1/products/:productId/reviews
// @access  Public (or protected depending on auth requirements)
export const createReview = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const productId = req.params.productId || req.body.productId;
  
  if (!productId) {
    return next(new AppError('Please provide a product ID', 400));
  }

  const { rating, title, review, name, email, anonymous, youtubeUrl } = req.body;

  // Handle image uploads
  const imageFiles = req.files as Express.Multer.File[];
  const imageUrls: string[] = [];

  if (imageFiles && imageFiles.length > 0) {
    for (const file of imageFiles) {
      try {
        const result = await uploadImageBuffer(file.buffer, 'solatide/reviews');
        imageUrls.push(result.secure_url);
      } catch (error) {
        console.error('Cloudinary upload error:', error);
      }
    }
  }

  // Handle anonymous mapping
  const isAnonymous = anonymous === 'true' || anonymous === true;
  const displayName = isAnonymous ? 'Anonymous' : (name || 'Anonymous Customer');

  const newReview = await Review.create({
    product: productId,
    rating: Number(rating),
    title,
    content: review,
    displayName,
    email,
    anonymous: isAnonymous,
    images: imageUrls,
    youtubeUrl,
    status: 'pending',
    emailVerified: false,
    verificationToken: crypto.randomBytes(32).toString('hex'),
    verificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  });

  // Get product name for email
  const product = await Product.findById(productId).select('name images');
  const productName = product?.name || 'our product';
  const productImage = product?.images?.[0]?.url || '';

  // Send verification email
  try {
    if (newReview.email) {
      await sendVerificationEmail(
        newReview.email,
        newReview.displayName,
        productName,
        productImage,
        newReview.rating,
        newReview.title || '',
        newReview.content,
        newReview.verificationToken!
      );
    }
  } catch (err) {
    console.error('Failed to send verification email:', err);
    // Don't fail the review creation if email fails
  }

  res.status(201).json({
    success: true,
    message: 'Review submitted successfully. Please verify your email before your review can be approved.',
    data: newReview,
  });
});

// @desc    Get reviews for a product with statistics
// @route   GET /api/v1/products/:productId/reviews
// @access  Public
export const getProductReviews = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { productId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return next(new AppError('Invalid Product ID', 400));
  }

  // Parse query params for pagination and sorting
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;
  const skip = (page - 1) * limit;
  const sortParam = req.query.sort as string || 'newest';
  
  let sortObj: any = { createdAt: -1 };
  if (sortParam === 'oldest') sortObj = { createdAt: 1 };
  if (sortParam === 'highest') sortObj = { rating: -1, createdAt: -1 };
  if (sortParam === 'lowest') sortObj = { rating: 1, createdAt: -1 };

  // Filter param (e.g., rating filter)
  const ratingFilter = req.query.rating ? parseInt(req.query.rating as string, 10) : null;

  const matchStage: any = {
    product: new mongoose.Types.ObjectId(productId),
    status: 'approved',
    emailVerified: true,
  };

  if (ratingFilter) {
    matchStage.rating = ratingFilter;
  }

  // Perform MongoDB Aggregation
  const result = await Review.aggregate([
    { $match: matchStage },
    {
      $facet: {
        // Global stats pipeline (ignores ratingFilter to give true global stats if we wanted, 
        // but normally stats are for all approved)
        stats: [
          { $match: { product: new mongoose.Types.ObjectId(productId), status: 'approved', emailVerified: true } },
          {
            $group: {
              _id: null,
              totalReviews: { $sum: 1 },
              averageRating: { $avg: '$rating' },
            },
          },
        ],
        // Distribution pipeline
        distribution: [
          { $match: { product: new mongoose.Types.ObjectId(productId), status: 'approved', emailVerified: true } },
          {
            $group: {
              _id: '$rating',
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
        ],
        // Paginated reviews pipeline
        reviews: [
          { $sort: sortObj },
          { $skip: skip },
          { $limit: limit },
        ],
      },
    },
  ]);

  const facetResult = result[0];
  const stats = facetResult.stats[0] || { totalReviews: 0, averageRating: 0 };
  const distribution = facetResult.distribution || [];

  // Format rating distribution
  const ratingDistribution: Record<string, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  const ratingPercentages: Record<string, string> = { 5: '0%', 4: '0%', 3: '0%', 2: '0%', 1: '0%' };

  distribution.forEach((item: any) => {
    ratingDistribution[item._id] = item.count;
    if (stats.totalReviews > 0) {
      ratingPercentages[item._id] = `${Math.round((item.count / stats.totalReviews) * 100)}%`;
    }
  });

  res.status(200).json({
    success: true,
    averageRating: stats.averageRating ? Number(stats.averageRating.toFixed(1)) : 0,
    totalReviews: stats.totalReviews,
    ratingDistribution,
    ratingPercentages,
    page,
    limit,
    reviews: facetResult.reviews,
  });
});

// @desc    Delete a review
// @route   DELETE /api/v1/reviews/:id
// @access  Private/Admin
export const deleteReview = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const review = await Review.findById(req.params.id);

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  // Delete associated images in Cloudinary
  if (review.images && review.images.length > 0) {
    for (const imgUrl of review.images) {
      await deleteImageByUrl(imgUrl);
    }
  }

  await review.deleteOne();

  res.status(200).json({
    success: true,
    data: {},
  });
});

// @desc    Update review status (approve/reject)
// @route   PATCH /api/v1/reviews/:id/status
// @access  Private/Admin
export const updateReviewStatus = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { status } = req.body;

  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return next(new AppError('Invalid status', 400));
  }

  const review = await Review.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true }
  );

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  res.status(200).json({
    success: true,
    data: review,
  });
});

// @desc    Get all reviews (Admin)
// @route   GET /api/v1/reviews
// @access  Private/Admin
export const getAllReviewsAdmin = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 20;
  const skip = (page - 1) * limit;
  const status = req.query.status as string;

  const query: any = {};
  if (status && status !== 'all') {
    query.status = status;
  }

  const reviews = await Review.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('product', 'name sku images');

  const total = await Review.countDocuments(query);

  res.status(200).json({
    success: true,
    data: {
      reviews,
      total,
      page,
      pages: Math.ceil(total / limit),
    }
  });
});

// @desc    Verify a review email
// @route   GET /api/v1/reviews/verify/:token
// @access  Public
export const verifyEmail = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { token } = req.params;

  const review = await Review.findOne({ verificationToken: token });

  if (!review) {
    return next(new AppError('Verification link is invalid.', 400));
  }

  if (review.emailVerified) {
    return next(new AppError('Review already verified.', 400));
  }

  if (review.verificationExpires && review.verificationExpires < new Date()) {
    return next(new AppError('Verification link has expired.', 400));
  }

  review.emailVerified = true;
  review.verificationToken = undefined;
  review.verificationExpires = undefined;
  // Keep status = "pending", do NOT auto approve
  
  await review.save({ validateBeforeSave: false });

  res.status(200).json({
    success: true,
    message: 'Review verified successfully',
  });
});

// @desc    Resend verification email (Admin)
// @route   POST /api/v1/reviews/:id/resend-verification
// @access  Private/Admin
export const resendVerificationEmailController = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const review = await Review.findById(req.params.id).populate('product', 'name images');
  
  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  if (review.emailVerified) {
    return next(new AppError('Review is already verified', 400));
  }

  if (!review.email) {
    return next(new AppError('Review does not have an email address associated', 400));
  }

  // Generate new token
  review.verificationToken = crypto.randomBytes(32).toString('hex');
  review.verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await review.save({ validateBeforeSave: false });

  // Get product name for email
  const productName = (review.product as any)?.name || 'our product';
  const productImage = (review.product as any)?.images?.[0]?.url || '';

  // Send verification email
  try {
    await sendVerificationEmail(
      review.email,
      review.displayName,
      productName,
      productImage,
      review.rating,
      review.title || '',
      review.content,
      review.verificationToken
    );
  } catch (err) {
    console.error('Failed to send verification email:', err);
    return next(new AppError('Failed to send verification email', 500));
  }

  res.status(200).json({
    success: true,
    message: 'Verification email resent successfully',
  });
});
