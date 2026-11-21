import type { NextFunction, Request, Response } from 'express';

import { createLogger } from '../core/logger.js';

const log = createLogger('http');

/** Endpoints that a load balancer hits every few seconds. Logging them buries the signal. */
const IGNORED_PATHS = new Set(['/health', '/health/live', '/health/ready', '/favicon.ico']);

/**
 * Access logging.
 *
 * We log on the response's `finish` event rather than on the way in, so a single
 * line carries the complete story: method, path, status, duration, client. The
 * level is chosen by outcome (5xx -> error, 4xx -> warn, else http), which means
 * `LOG_LEVEL=warn` in production still surfaces every failing request while
 * staying quiet about the healthy ones.
 */
export function httpLogger(req: Request, res: Response, next: NextFunction): void {
  if (IGNORED_PATHS.has(req.path)) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const payload = {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      contentLength: res.getHeader('content-length'),
    };

    const message = `${req.method} ${payload.path} ${res.statusCode} ${payload.durationMs}ms`;

    if (res.statusCode >= 500) {
      log.error(message, payload);
    } else if (res.statusCode >= 400) {
      log.warn(message, payload);
    } else {
      log.http(message, payload);
    }
  });

  next();
}
