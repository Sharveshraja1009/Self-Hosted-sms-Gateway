import type { Response } from 'express';

import { getRequestId } from './request-context.js';

/**
 * One envelope for every response.
 *
 * Clients should never have to guess the shape of a payload. Success is always
 * `{ success: true, data, meta? }`; failure is always
 * `{ success: false, error: { code, message, details? } }`. The Android app and
 * the dashboard both parse exactly these two shapes, forever.
 */

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown> | PaginationMeta;
  requestId?: string;
}

export interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

/**
 * These return `void`, not the Response object. Express's own `.json()` is typed
 * as `Response<any>`, so returning it would launder an `any` back into typed
 * code. Handlers should send and finish, not chain.
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown> | PaginationMeta,
): void {
  const body: SuccessBody<T> = { success: true, data };
  if (meta) body.meta = meta;

  const requestId = getRequestId();
  if (requestId) body.requestId = requestId;

  res.status(statusCode).json(body);
}

export function sendCreated<T>(res: Response, data: T): void {
  sendSuccess(res, data, 201);
}

export function sendNoContent(res: Response): void {
  res.status(204).send();
}

/** Builds the pagination `meta` block from the raw numbers a repository returns. */
export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
