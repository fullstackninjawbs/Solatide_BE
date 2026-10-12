import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import User, { IUser } from '../models/user.model';
import AppError from '../utils/appError';
import catchAsync from '../utils/catchAsync';
import { Role } from '../config/roles';

export interface AuthenticatedRequest extends Request {
  user?: IUser;
}

interface JwtPayload {
  id: string;
  iat: number;
  exp: number;
}

const extractBearerToken = (req: Request): string | undefined => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token || undefined;
  }
  return undefined;
};

/**
 * Verify a JWT (HS256 only) and load the user. Returns null when the token is
 * invalid/expired, the user no longer exists, or the token predates the user's
 * last password change.
 */
const resolveUserFromToken = async (token: string): Promise<IUser | null> => {
  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
  } catch {
    return null;
  }
  if (!decoded || typeof decoded.id !== 'string') return null;

  const currentUser = await User.findById(decoded.id);
  if (!currentUser) return null;

  // Reject tokens issued before the last password change. `passwordChangedAt` is not
  // (yet) declared on the User schema, so read it defensively.
  const changedAt: unknown = (currentUser as any).passwordChangedAt ?? (currentUser as any).get?.('passwordChangedAt');
  if (changedAt) {
    const changedMs = new Date(changedAt as any).getTime();
    if (!Number.isNaN(changedMs) && typeof decoded.iat === 'number' && decoded.iat * 1000 < changedMs - 1000) {
      return null;
    }
  }

  return currentUser;
};

/**
 * Protect middleware: Ensures the request is authenticated with a valid JWT
 */
export const protect = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const token = extractBearerToken(req);

  if (!token) {
    return next(new AppError('You are not logged in! Please log in to get access.', 401));
  }

  const currentUser = await resolveUserFromToken(token);
  if (!currentUser) {
    return next(new AppError('Your session is invalid or expired. Please log in again.', 401));
  }

  req.user = currentUser;
  next();
});

/**
 * Optional Auth middleware: Populates req.user if a valid JWT is present,
 * but allows the request to proceed as a guest if missing or invalid.
 */
export const optionalAuth = catchAsync(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const token = extractBearerToken(req);
  if (!token) return next();

  try {
    const currentUser = await resolveUserFromToken(token);
    if (currentUser) {
      req.user = currentUser;
    }
  } catch {
    // Proceed as guest on any lookup error
  }

  next();
});

/**
 * Restrict routes to specific user roles. Must run after `protect`.
 */
export const restrictTo = (...roles: Role[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('You are not logged in! Please log in to get access.', 401));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};
