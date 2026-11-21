import type { NextFunction, Request, Response } from 'express';

import { AppError, ErrorCode } from '../core/errors.js';

/**
 * Catch-all for unmatched routes.
 *
 * Registered after every router, before the error handler. Without it Express
 * would emit its own HTML 404 page, breaking the JSON contract that clients rely
 * on - and leaking the framework's identity while it's at it.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(`Route ${req.method} ${req.originalUrl.split('?')[0]} does not exist`, {
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
    }),
  );
}
