import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { runWithContext } from '../core/request-context.js';

/** Only accept an upstream id that looks sane - never echo attacker-controlled junk into logs. */
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Assigns a correlation id to every request and opens the AsyncLocalStorage
 * scope that the logger reads from.
 *
 * If a load balancer or the Android app already sent `X-Request-Id` we keep it,
 * so a single id spans the whole distributed call. Otherwise we mint a UUID.
 * The id goes back out on the response header so a user reporting "it failed"
 * can hand you the exact string to grep for.
 *
 * This must be the FIRST middleware registered - everything downstream, including
 * the error handler, depends on the context it opens.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);

  runWithContext({ requestId: id }, () => {
    next();
  });
}
