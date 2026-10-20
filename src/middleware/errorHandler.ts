import { Request, Response, NextFunction } from 'express';
import AppError from '../utils/appError';
import config from '../config';

/**
 * Handles database cast errors (invalid ObjectIDs)
 */
const handleCastErrorDB = (err: any) => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

/**
 * Handles database duplicate key errors (code 11000)
 */
const handleDuplicateFieldsDB = (err: any) => {
  const value = err.errmsg?.match(/(["'])(\\?.)*?\1/)?.[0] || 'Unknown field';
  
  if (err.errmsg && err.errmsg.includes('slug_1')) {
    return new AppError('This URL handle is already being used by another product.', 400);
  }

  const message = `Duplicate field value: ${value}. Please use another value!`;
  return new AppError(message, 400);
};

/**
 * Handles database validation errors
 */
const handleValidationErrorDB = (err: any) => {
  const errors = Object.values(err.errors).map((el: any) => el.message);
  const message = `Invalid input data. ${errors.join('. ')}`;
  return new AppError(message, 400);
};

/**
 * Handles JWT verification errors
 */
const handleJWTError = () => new AppError('Invalid token. Please log in again.', 401);

/**
 * Handles JWT token expiration errors
 */
const handleJWTExpiredError = () => new AppError('Your token has expired! Please log in again.', 401);

/**
 * MongoDB unreachable / timed out (Atlas outage, network blip): a temporary condition, not a bug.
 * Answer 503 and log one line instead of a [CRITICAL ERROR] dump per request.
 */
const DB_UNAVAILABLE_ERRORS = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
  'MongoPoolClearedError',
  'MongoNotConnectedError',
]);
export const isDbUnavailableError = (err: any): boolean =>
  DB_UNAVAILABLE_ERRORS.has(err?.name) || /buffering timed out|Client must be connected/i.test(err?.message || '');

const handleDbUnavailable = (err: any, req: Request, res: Response) => {
  console.error(`[Database] ${req.method} ${req.path} failed: ${err.name}: ${err.message}`);
  res.set('Retry-After', '30');
  res.status(503).json({
    success: false,
    status: 'error',
    message: 'Service temporarily unavailable. Please try again shortly.',
  });
};

/**
 * Send detailed error details in development mode
 */
const sendErrorDev = (err: AppError, res: Response) => {
  res.status(err.statusCode || 500).json({
    success: false,
    status: err.status,
    message: err.message,
    error: err,
    stack: err.stack,
  });
};

/**
 * Send minimal error details in production mode
 */
const sendErrorProd = (err: AppError, res: Response) => {
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    res.status(err.statusCode).json({
      success: false,
      status: err.status,
      message: err.message,
    });
  } else {
    // Programming or unknown error: log full detail server-side, never leak it
    console.error('[CRITICAL ERROR]', err);
    res.status(500).json({
      success: false,
      status: 'error',
      message: 'Something went wrong',
    });
  }
};

/**
 * Centralized Global Error Handler Middleware
 */
export const buildErrorHandler = (env: string) => (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (res.headersSent) {
    return next(err);
  }

  if (isDbUnavailableError(err)) {
    handleDbUnavailable(err, req, res);
  } else if (env === 'development') {
    sendErrorDev(err, res);
  } else {
    let error = Object.assign(Object.create(Object.getPrototypeOf(err)), err);
    error.message = err.message;

    if (error.name === 'CastError') error = handleCastErrorDB(error);
    if (error.code === 11000) error = handleDuplicateFieldsDB(error);
    if (error.name === 'ValidationError') error = handleValidationErrorDB(error);
    if (error.name === 'JsonWebTokenError') error = handleJWTError();
    if (error.name === 'TokenExpiredError') error = handleJWTExpiredError();
    if (err.type === 'entity.too.large') error = new AppError('Request body too large.', 413);
    if (err.type === 'entity.parse.failed') error = new AppError('Malformed JSON body.', 400);
    if (err.name === 'MulterError') error = new AppError(`Upload rejected: ${err.code || 'invalid file'}`, 400);

    sendErrorProd(error, res);
  }
};

export const errorHandler = buildErrorHandler(config.env);

export default errorHandler;
