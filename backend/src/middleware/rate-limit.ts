import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';

import { env, isTest } from '../config/env.js';
import { ErrorCode, TooManyRequestsError } from '../core/errors.js';

/**
 * Rate limiting.
 *
 * Phase 1 ships the in-memory store, which is correct and sufficient for a
 * single process. In Phase 4, once Redis is up, we swap in a Redis store so the
 * limit is shared across every replica - the API surface here does not change.
 *
 * Limiters funnel their rejection through our own `TooManyRequestsError` so a
 * throttled request comes back in the same envelope as every other failure,
 * carrying `RATE_LIMIT_EXCEEDED` and a `Retry-After` header.
 */

function buildLimiter(options: Partial<Options> & { windowMs: number; limit: number }) {
  return rateLimit({
    standardHeaders: 'draft-7', // RateLimit-Limit / -Remaining / -Reset
    legacyHeaders: false,
    // Disabled under test so suites don't trip over each other's counters.
    skip: () => isTest,
    handler: (req, _res, next, opts) => {
      const retryAfterSeconds = Math.ceil(opts.windowMs / 1000);
      next(
        new TooManyRequestsError('Too many requests. Please slow down.', {
          retryAfterSeconds,
          code: ErrorCode.RATE_LIMIT_EXCEEDED,
        }),
      );
    },
    ...options,
  });
}

/** Applied to the whole API. A blunt instrument against runaway clients and scrapers. */
export const globalRateLimiter = buildLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
});

/**
 * Credential endpoints. Deliberately brutal: 10 attempts per 15 minutes per IP.
 * `ipKeyGenerator` normalises IPv6 into a /56 subnet, so an attacker cannot
 * sidestep the counter by rotating through the addresses of a single machine.
 */
export const authRateLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
});

/** Sending SMS is the expensive path (a real SIM, real money). Tighter than the global cap. */
export const sendSmsRateLimiter = buildLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
});
