/**
 * The error taxonomy.
 *
 * Every failure the API can produce is one of these. Two properties make this
 * work in production:
 *
 *  - `code` is a stable machine-readable string. Clients (dashboard, Android app,
 *    third-party integrators) branch on it. HTTP status alone is too coarse:
 *    "daily limit reached" and "too many login attempts" are both 429 but need
 *    very different UI.
 *  - `isOperational` separates *expected* failures (bad input, wrong password,
 *    gateway offline) from *bugs* (null deref). Operational errors are returned
 *    to the caller verbatim; bugs are logged with a stack and reduced to a
 *    generic 500 so we never leak internals.
 */

export const ErrorCode = {
  // 400 / 422
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_PHONE_NUMBER: 'INVALID_PHONE_NUMBER',

  // 401
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  API_KEY_INVALID: 'API_KEY_INVALID',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',

  // 404
  NOT_FOUND: 'NOT_FOUND',

  // 409
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',

  // 429
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  DAILY_LIMIT_EXCEEDED: 'DAILY_LIMIT_EXCEEDED',
  OTP_MAX_ATTEMPTS: 'OTP_MAX_ATTEMPTS',

  // 500 / 503
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  NO_GATEWAY_AVAILABLE: 'NO_GATEWAY_AVAILABLE',
  GATEWAY_OFFLINE: 'GATEWAY_OFFLINE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Machine-readable detail attached to an error (e.g. per-field validation issues). */
export type ErrorDetails = Record<string, unknown> | unknown[];

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCodeValue;
  public readonly details?: ErrorDetails;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: ErrorCodeValue;
      details?: ErrorDetails;
      isOperational?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? ErrorCode.INTERNAL_ERROR;
    this.details = options.details;
    this.isOperational = options.isOperational ?? true;

    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: ErrorDetails, code: ErrorCodeValue = ErrorCode.BAD_REQUEST) {
    super(message, { statusCode: 400, code, details });
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: ErrorDetails) {
    super(message, { statusCode: 422, code: ErrorCode.VALIDATION_ERROR, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code: ErrorCodeValue = ErrorCode.UNAUTHORIZED) {
    super(message, { statusCode: 401, code });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource', code: ErrorCodeValue = ErrorCode.FORBIDDEN) {
    super(message, { statusCode: 403, code });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { statusCode: 404, code: ErrorCode.NOT_FOUND });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', code: ErrorCodeValue = ErrorCode.CONFLICT) {
    super(message, { statusCode: 409, code });
  }
}

export class TooManyRequestsError extends AppError {
  /** `retryAfterSeconds` is surfaced as the standard `Retry-After` header. */
  public readonly retryAfterSeconds?: number;

  constructor(
    message = 'Too many requests',
    options: { retryAfterSeconds?: number; code?: ErrorCodeValue; details?: ErrorDetails } = {},
  ) {
    super(message, {
      statusCode: 429,
      code: options.code ?? ErrorCode.RATE_LIMIT_EXCEEDED,
      details: options.details,
    });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', code: ErrorCodeValue = ErrorCode.SERVICE_UNAVAILABLE) {
    super(message, { statusCode: 503, code });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super(message, { statusCode: 500, code: ErrorCode.INTERNAL_ERROR, isOperational: false, cause });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * True when the process is still in a known-good state and may keep serving.
 * Anything else (a bug, an OOM) should take the process down and let the
 * orchestrator restart it with a clean slate.
 */
export function isOperationalError(error: unknown): boolean {
  return isAppError(error) && error.isOperational;
}
