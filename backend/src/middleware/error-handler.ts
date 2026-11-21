import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { isProduction } from '../config/env.js';
import { AppError, ErrorCode, TooManyRequestsError, ValidationError } from '../core/errors.js';
import type { ErrorBody } from '../core/http-response.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('error');

/**
 * The single exit point for every failure in the API.
 *
 * Express 5 forwards rejected promises from async handlers here automatically,
 * so services can simply `throw new NotFoundError('Message')` and trust that the
 * caller sees a correct, consistently-shaped 404.
 *
 * The security-critical part is the bottom branch: anything that is *not* a known
 * operational error is treated as a bug. It gets logged in full (stack included)
 * and returned to the client as a bare 500 - never the raw message, which could
 * contain a connection string, a SQL fragment or a file path.
 */

/** Normalises anything thrown - Error, string, Zod issue, body-parser failure - into an AppError. */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new ValidationError('Request validation failed', error.issues);
  }

  // express.json() rejects malformed payloads with a SyntaxError carrying `status`.
  if (error instanceof SyntaxError && 'body' in error) {
    return new AppError('Malformed JSON in request body', {
      statusCode: 400,
      code: ErrorCode.BAD_REQUEST,
    });
  }

  // Payload too large, from body-parser.
  if (typeof error === 'object' && error !== null && (error as { type?: string }).type === 'entity.too.large') {
    return new AppError('Request payload too large', {
      statusCode: 413,
      code: ErrorCode.BAD_REQUEST,
    });
  }

  const cause = error instanceof Error ? error : new Error(String(error));
  const internal = new AppError(cause.message, {
    statusCode: 500,
    code: ErrorCode.INTERNAL_ERROR,
    isOperational: false,
    cause,
  });
  internal.stack = cause.stack;
  return internal;
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  // Express default handler must take over once headers are on the wire.
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = toAppError(error);

  const logPayload = {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    statusCode: appError.statusCode,
    code: appError.code,
    ip: req.ip,
  };

  if (!appError.isOperational || appError.statusCode >= 500) {
    // A real bug or a downstream outage: keep the stack.
    log.error(appError.message, { ...logPayload, stack: appError.stack });
  } else if (appError.statusCode >= 400) {
    // Expected: bad input, wrong password, over quota. Noise at error level.
    log.warn(appError.message, logPayload);
  }

  if (appError instanceof TooManyRequestsError && appError.retryAfterSeconds) {
    res.setHeader('Retry-After', String(appError.retryAfterSeconds));
  }

  const exposeMessage = appError.isOperational || !isProduction;

  const body: ErrorBody = {
    success: false,
    error: {
      code: appError.code,
      message: exposeMessage ? appError.message : 'Internal server error',
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
    requestId: req.id,
  };

  // Stacks are a debugging aid, never a production response.
  if (!isProduction && !appError.isOperational) {
    (body.error as Record<string, unknown>).stack = appError.stack;
  }

  res.status(appError.statusCode).json(body);
}
