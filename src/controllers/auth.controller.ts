import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import config from '../config';
import User from '../models/user.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import { sendResetPasswordEmail } from '../services/emailService';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Generate a JWT token signed with the user ID (HS256)
 */
const signToken = (id: string): string => {
  return jwt.sign({ id }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn as any,
  });
};

/**
 * Whitelisted, safe user representation for API responses — never includes the
 * password hash or reset token/expiry.
 */
export const toSafeUser = (user: any) => {
  if (!user) return null;
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

/**
 * Mark the password as changed now so previously issued JWTs are rejected by
 * `protect`. The User schema does not (yet) declare `passwordChangedAt`, so set it
 * with strict:false so it is persisted either way.
 */
export const markPasswordChanged = (user: any) => {
  // 1s in the past so the token issued right after (iat in whole seconds) stays valid
  const when = new Date(Date.now() - 1000);
  if (typeof user.set === 'function') {
    user.set('passwordChangedAt', when, { strict: false });
  } else {
    user.passwordChangedAt = when;
  }
};

export const validatePassword = (password: unknown): string | null => {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  }
  return null;
};

const normEmail = (email: unknown): string | null =>
  typeof email === 'string' && email.trim() && email.length <= 254 ? email.trim().toLowerCase() : null;

/**
 * Helper to structure the auth response containing token and user details
 */
const sendTokenResponse = (user: any, statusCode: number, res: Response) => {
  const token = signToken(String(user._id));

  res.status(statusCode).json({
    success: true,
    token,
    data: {
      user: toSafeUser(user),
    },
  });
};

const GENERIC_REGISTER_MESSAGE =
  'If this email address can be registered, your account is ready. Please log in to continue.';

/**
 * Register a new customer account.
 * SECURITY: role is NEVER taken from the request — public registration always
 * creates role 'user'. The response is identical whether or not the email was
 * already registered (no account enumeration), and no token is issued here.
 */
export const register = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { name, password } = req.body || {};
  const email = normEmail(req.body?.email);

  if (typeof name !== 'string' || !name.trim() || !email) {
    return next(new AppError('Please provide a name, email and password.', 400));
  }
  const pwError = validatePassword(password);
  if (pwError) return next(new AppError(pwError, 400));

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    // Equalise timing with the create path (bcrypt hash) to avoid enumeration via latency
    await bcrypt.hash(password, 10);
  } else {
    try {
      await User.create({
        name: name.trim(),
        email,
        password,
        role: 'user',
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // concurrent duplicate → same generic response
    }
  }

  res.status(201).json({ success: true, message: GENERIC_REGISTER_MESSAGE });
});

/**
 * Log in an existing user
 */
export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { password } = req.body || {};
  const email = normEmail(req.body?.email);

  if (!email || typeof password !== 'string' || !password) {
    return next(new AppError('Please provide email and password', 400));
  }

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError('Invalid email or password', 401));
  }

  sendTokenResponse(user, 200, res);
});

/**
 * Fetch currently logged in user context (safe fields only)
 */
export const getMe = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  res.status(200).json({
    success: true,
    data: {
      user: toSafeUser(req.user),
    },
  });
});

const GENERIC_FORGOT_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

/**
 * Request password reset link. Always returns the same response.
 */
export const forgotPassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const email = normEmail(req.body?.email);

  if (!email) {
    return next(new AppError('Please provide an email address.', 400));
  }

  const user = await User.findOne({ email });
  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save({ validateBeforeSave: false });

    try {
      await sendResetPasswordEmail(user.email, resetToken, user.name);
    } catch (err) {
      console.error('[Auth] Failed to send password reset email:', (err as Error).message);
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });
    }
  }

  res.status(200).json({ success: true, message: GENERIC_FORGOT_MESSAGE });
});

/**
 * Reset password using token
 */
export const resetPassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { token } = req.params;
  const { password } = req.body || {};

  const pwError = validatePassword(password);
  if (pwError) return next(new AppError(pwError, 400));
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
    return next(new AppError('Token is invalid or has expired.', 400));
  }

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: new Date() },
  });

  if (!user) {
    return next(new AppError('Token is invalid or has expired.', 400));
  }

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  markPasswordChanged(user); // invalidates previously issued JWTs
  await user.save(); // pre-save hook hashes the password

  sendTokenResponse(user, 200, res);
});
