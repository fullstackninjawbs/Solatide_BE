import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import User, { IUser } from '../models/user.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';

export interface AuthenticatedRequest extends Request {
  user?: IUser;
}

interface JwtPayload {
  id: string;
  iat: number;
  exp: number;
}

/**
 * Protect middleware: Ensures the request is authenticated with a valid JWT
 */
export const protect = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let token: string | undefined;

  // 1) Extract token from Authorization header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(new AppError('You are not logged in! Please log in to get access.', 401));
  }

  // 2) Verify JWT token
  const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;

  // 3) Check if user still exists in the database
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(new AppError('The user belonging to this token no longer exists.', 401));
  }

  // 4) Grant access and save user on Request object
  req.user = currentUser;
  next();
});

/**
 * Optional Auth middleware: Populates req.user if a valid JWT is present,
 * but allows the request to proceed as a guest if missing or invalid.
 */
export const optionalAuth = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let token: string | undefined;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
    const currentUser = await User.findById(decoded.id);
    if (currentUser) {
      req.user = currentUser;
    }
  } catch (err) {
    // Ignore JWT errors (e.g., invalid signature, expired) and proceed as guest
  }

  next();
});

/**
 * Restrict routes to specific user roles (e.g., admin)
 */
export const restrictTo = (...roles: Array<'super_admin' | 'operations' | 'content_manager' | 'support' | 'user' | 'admin'>) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};
