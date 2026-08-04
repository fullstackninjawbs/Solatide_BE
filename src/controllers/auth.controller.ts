import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config';
import User from '../models/user.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';
import { sendResetPasswordEmail } from '../services/emailService';

/**
 * Generate a JWT token signed with the user ID
 */
const signToken = (id: string): string => {
  return jwt.sign({ id }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as any,
  });
};

/**
 * Helper to structure the auth response containing token and user details
 */
const sendTokenResponse = (user: any, statusCode: number, res: Response) => {
  const token = signToken(user._id);

  // Remove password from output
  user.password = undefined;

  res.status(statusCode).json({
    success: true,
    token,
    data: {
      user,
    },
  });
};

/**
 * Register a new user
 */
export const register = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { name, email, password, role } = req.body;

  // 1) Check if email is already taken
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return next(new AppError('Email address is already in use', 400));
  }

  // 2) Create new user
  const newUser = await User.create({
    name,
    email,
    password,
    role: role || 'user', // Default to user role
  });

  sendTokenResponse(newUser, 201, res); // 201 Created
});

/**
 * Log in an existing user
 */
export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { email, password } = req.body;

  // 1) Verify input存在
  if (!email || !password) {
    return next(new AppError('Please provide email and password', 400));
  }

  // 2) Find user and explicitly select password field (which is select: false)
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError('Invalid email or password', 401));
  }

  // 3) Emit token response
  sendTokenResponse(user, 200, res);
});

/**
 * Fetch currently logged in user context
 */
export const getMe = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  res.status(200).json({
    success: true,
    data: {
      user: req.user,
    },
  });
});

/**
 * Request password reset link
 */
export const forgotPassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { email } = req.body;

  if (!email) {
    return next(new AppError('Please provide an email address.', 400));
  }

  // 1) Find user
  const user = await User.findOne({ email });
  if (!user) {
    // For security, don't expose if email is registered or not in production
    // But since this is admin, let's return error if user doesn't exist
    return next(new AppError('No user found with that email address.', 404));
  }

  // 2) Generate random reset token
  const resetToken = crypto.randomBytes(32).toString('hex');

  // 3) Store hashed token in DB with 10 min expiry
  user.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
  user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await user.save({ validateBeforeSave: false });

  // 4) Send reset link to user email
  try {
    await sendResetPasswordEmail(user.email, resetToken, user.name);
    res.status(200).json({
      success: true,
      message: 'Password reset link sent to email.',
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(new AppError('There was an error sending the email. Try again later.', 500));
  }
});

/**
 * Reset password using token
 */
export const resetPassword = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { token } = req.params;
  const { password } = req.body;

  if (!password) {
    return next(new AppError('Please provide a new password.', 400));
  }

  // 1) Hash token passed in from URL and match with DB token
  const hashedToken = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: new Date() },
  });

  // 2) If token is invalid or expired, return error
  if (!user) {
    return next(new AppError('Token is invalid or has expired.', 400));
  }

  // 3) Set new password and clear token fields
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save(); // pre-save hook will hash it automatically

  // 4) Send back JWT response so they are logged in immediately
  sendTokenResponse(user, 200, res);
});
