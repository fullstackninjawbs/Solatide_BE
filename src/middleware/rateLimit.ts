import rateLimit from 'express-rate-limit';

/**
 * General API limiter — applied globally to all routes.
 * Allows 200 requests per 15 minutes per IP.
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000,
  standardHeaders: true,  // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again after 15 minutes.',
  },
  skip: (req) => {
    // Skip rate limiting for Tagada webhook — secured by HMAC signature instead
    return req.path === '/api/payments/tagada/webhook';
  },
});

/**
 * Strict auth limiter — for login/register endpoints.
 * Allows only 10 attempts per 15 minutes per IP.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again after 15 minutes.',
  },
});

/**
 * Public product limiter — for high-traffic product catalog endpoints.
 * Allows 300 requests per 15 minutes (more generous for public browsing).
 */
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again shortly.',
  },
});
