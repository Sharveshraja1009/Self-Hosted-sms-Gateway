import { Router } from 'express';

import { healthController } from './health.controller.js';

/**
 * Health routes.
 *
 * Mounted twice on purpose (see app.ts): at the API prefix for humans, and at
 * the bare root for infrastructure. Kubernetes probes and Docker healthchecks
 * should not have to know or care what `API_PREFIX` was configured to.
 *
 *   GET /health        -> liveness  (always 200 while the event loop turns)
 *   GET /health/ready  -> readiness (200 / 503 depending on dependencies)
 *   GET /health/info   -> build + runtime details
 */
export const healthRouter: Router = Router();

healthRouter.get('/', healthController.live);
healthRouter.get('/live', healthController.live);
healthRouter.get('/ready', healthController.ready);
healthRouter.get('/info', healthController.info);
