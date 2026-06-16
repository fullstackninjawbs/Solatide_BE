import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import User from '../models/user.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { AuthenticatedRequest } from '../middleware/auth';

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
