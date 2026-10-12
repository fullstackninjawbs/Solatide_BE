import { Router } from 'express';
import {
  createReview,
  getProductReviews,
  deleteReview,
  updateReviewStatus,
  getAllReviewsAdmin,
  verifyEmail,
  resendVerificationEmailController,
  importReviews,
} from '../controllers/review.controller';
import { protect, restrictTo } from '../middleware/auth';
import { ACCESS } from '../config/roles';
import { formSubmitLimiter } from '../middleware/rateLimit';
import { reviewImageUpload, spreadsheetUpload } from '../middleware/uploadFilters';

const router = Router();

// ============================================
// PUBLIC ROUTES
// ============================================

// Get reviews for a specific product
// GET /api/v1/reviews/product/:productId
// (Often routed via /api/v1/products/:productId/reviews, but we can also use /api/v1/reviews/product/:productId)
router.get('/product/:productId', getProductReviews);

// Verify email review
// GET /api/v1/reviews/verify/:token
router.get('/verify/:token', verifyEmail);

// Create a review
// POST /api/v1/reviews
router.post(
  '/',
  formSubmitLimiter, // 10 submissions / hour / IP
  reviewImageUpload.array('images', 5), // up to 5 images, 5MB each, jpeg/png/webp/gif only
  createReview
);

// ============================================
// ADMIN ROUTES (Protected)
// ============================================

router.use(protect); // Require auth for all routes below
router.use(restrictTo(...ACCESS.reviews));

// Get all reviews (Admin) — support may view & moderate
router.get('/', getAllReviewsAdmin);

// Update review status (approve/reject)
router.patch('/:id/status', updateReviewStatus);

// Import reviews from XLSX/CSV
router.post('/import', restrictTo(...ACCESS.reviewsManage), spreadsheetUpload.single('file'), importReviews);

// Delete a review
router.delete('/:id', restrictTo(...ACCESS.reviewsManage), deleteReview);

// Resend verification email
router.post('/:id/resend-verification', restrictTo(...ACCESS.reviewsManage), resendVerificationEmailController);

export default router;
