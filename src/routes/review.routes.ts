import { Router } from 'express';
import multer from 'multer';
import {
  createReview,
  getProductReviews,
  deleteReview,
  updateReviewStatus,
  getAllReviewsAdmin,
  verifyEmail,
  resendVerificationEmailController,
} from '../controllers/review.controller';
import { protect, restrictTo } from '../middleware/auth';

const router = Router();

// Multer memory storage configuration for file stream parsing
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Capped at 10MB to prevent heap overflow
  },
});

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
  upload.array('images', 5), // Allow up to 5 images
  createReview
);

// ============================================
// ADMIN ROUTES (Protected)
// ============================================

router.use(protect); // Require auth for all routes below
router.use(restrictTo('super_admin', 'operations', 'admin'));

// Get all reviews (Admin)
router.get('/', getAllReviewsAdmin);

// Delete a review
router.delete('/:id', deleteReview);

// Update review status (approve/reject)
router.patch('/:id/status', updateReviewStatus);

// Resend verification email
router.post('/:id/resend-verification', resendVerificationEmailController);

export default router;
