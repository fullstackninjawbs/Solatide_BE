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
 * Restrict routes to specific user roles (e.g., admin)
 */
export const restrictTo = (...roles: Array<'user' | 'admin'>) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};
