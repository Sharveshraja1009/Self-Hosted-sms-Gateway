import type { NextFunction, Request, Response } from 'express';
import type { ZodError, ZodType } from 'zod';

import { ValidationError } from '../core/errors.js';

/**
 * Zod request validation.
 *
 * Nothing reaches a service layer without passing through here first. This is
 * the single choke point where untrusted input becomes a typed value, which is
 * what makes the rest of the codebase safe to write without defensive checks.
 *
 * Because Express 5 exposes `req.query` as a read-only getter, the parsed output
 * lands on `req.validated` (see src/types/express.d.ts). Handlers read from
 * there - never from the raw `req.query`/`req.params`.
 *
 * Usage:
 *   router.post('/send', validate({ body: sendMessageSchema }), controller.send);
 *   const { phone } = req.validated!.body as SendMessageInput;
 */

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/** Flattens Zod issues into a client-friendly `[{ field, message, code }]` list. */
function formatIssues(error: ZodError, source: keyof ValidationSchemas) {
  return error.issues.map((issue) => ({
    source,
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: ReturnType<typeof formatIssues> = [];
    const validated: NonNullable<Request['validated']> = {};

    for (const source of ['body', 'query', 'params'] as const) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);

      if (result.success) {
        validated[source] = result.data;
      } else {
        issues.push(...formatIssues(result.error, source));
      }
    }

    if (issues.length > 0) {
      next(new ValidationError('Request validation failed', issues));
      return;
    }

    req.validated = validated;

    // `req.body` is writable in Express 5 and handlers habitually reach for it,
    // so keep it in sync with the coerced/stripped output rather than leaving a
    // stale unvalidated copy behind.
    if (validated.body !== undefined) {
      req.body = validated.body;
    }

    next();
  };
}

/** Typed accessors so handlers don't litter `as` casts everywhere. */
export function validatedBody<T>(req: Request): T {
  return req.validated?.body as T;
}

export function validatedQuery<T>(req: Request): T {
  return req.validated?.query as T;
}

export function validatedParams<T>(req: Request): T {
  return req.validated?.params as T;
}
