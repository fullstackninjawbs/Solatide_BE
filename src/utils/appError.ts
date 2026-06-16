/**
 * Custom Operational Error Class
 * Distinguishes operational errors (expected client-facing errors like invalid input, 404, etc.)
 * from programming errors (unexpected server failures).
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly status: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);

    this.statusCode = statusCode;
    // status is 'fail' for 4xx errors, and 'error' for 5xx errors
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;

    // Capture the stack trace, keeping the constructor call out of it
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
