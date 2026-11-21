import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http-response.js';
import { healthService } from './health.service.js';

/**
 * Thin HTTP adapter over the health service.
 *
 * Controllers in this codebase do exactly three things: read validated input,
 * call a service, shape a response. No business logic lives here - which is what
 * lets the service be unit-tested without an HTTP server.
 *
 * Handlers are arrow functions, not shorthand methods, so that passing them to
 * `router.get(...)` cannot silently detach `this`. Express calls handlers
 * unbound; a shorthand method that ever grew a `this.` reference would break at
 * runtime, not compile time. Arrows make that class of bug unrepresentable.
 */
export const healthController = {
  live: (_req: Request, res: Response): void => {
    sendSuccess(res, healthService.liveness());
  },

  ready: async (_req: Request, res: Response): Promise<void> => {
    const result = await healthService.readiness();
    // 503 is the contract: load balancers and `docker compose --wait` key off it.
    sendSuccess(res, result, result.ready ? 200 : 503);
  },

  info: (_req: Request, res: Response): void => {
    sendSuccess(res, healthService.info());
  },
};
