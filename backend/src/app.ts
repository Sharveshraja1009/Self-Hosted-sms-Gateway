import path from 'node:path';

import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env, isProduction } from './config/env.js';
import { ForbiddenError } from './core/errors.js';
import { createLogger } from './core/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { httpLogger } from './middleware/http-logger.js';
import { notFoundHandler } from './middleware/not-found.js';
import { globalRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { healthRouter } from './modules/health/health.routes.js';
import { apiRouter } from './routes/index.js';

/**
 * The Express application, assembled as a pure factory.
 *
 * `createApp()` returns an app but never listens on a port. That separation is
 * what lets the test suite spin up the entire HTTP stack in-process with
 * supertest - no ports, no races, no cleanup - while `server.ts` owns the real
 * socket, signals and shutdown.
 *
 * Middleware order below is not cosmetic; it is the contract:
 *   1. requestId    - opens the correlation scope everything else logs into
 *   2. security     - helmet/cors reject before we spend cycles parsing
 *   3. parsing      - body available to routes
 *   4. rate limit   - counted after CORS preflight, before business logic
 *   5. routes       - the actual work
 *   6. 404          - nothing matched
 *   7. errorHandler - the only place that writes an error response
 */
const log = createLogger('app');

export function createApp(): Express {
  const app = express();

  // Behind nginx/traefik, `req.ip` is the proxy unless we say how many hops to
  // trust. Rate limiting and audit logs are worthless without the real client IP.
  // Never `true`: that trusts a spoofed X-Forwarded-For from anyone.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  // --- 1. Correlation -------------------------------------------------------
  app.use(requestId);

  // --- 2. Security ----------------------------------------------------------
  app.use(
    helmet({
      // This is a JSON API; a browser never renders our responses directly.
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  const allowedOrigins = new Set(env.CORS_ORIGINS);
  const corsOptions = {
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    maxAge: 86_400,
  };

  // The delegate form (req, callback) is used, not the plain `origin` function,
  // because deciding "is this the server's own admin panel?" needs the request's
  // Host - and only the delegate gets the request.
  app.use(
    cors((req, callback) => {
      const origin = req.headers.origin;

      // No Origin header = server-to-server (curl, the Android app, other backends).
      // CORS is a browser mechanism; these callers authenticate by API key or JWT,
      // so there is nothing to protect here.
      if (!origin) {
        callback(null, { ...corsOptions, origin: true });
        return;
      }

      // Same-origin as the server itself - the built-in admin panel at /admin,
      // whose fetches to /api carry an Origin header on POST. Compared by HOST so
      // it works however the server is reached (localhost, a LAN IP, a public
      // domain) without having to list each one in CORS_ORIGINS.
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === req.headers.host;
      } catch {
        sameOrigin = false;
      }

      if (sameOrigin || allowedOrigins.has(origin) || allowedOrigins.has('*')) {
        callback(null, { ...corsOptions, origin: true });
        return;
      }

      callback(new ForbiddenError(`Origin "${origin}" is not allowed by CORS policy`));
    }),
  );

  // --- 3. Parsing + transport ----------------------------------------------
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: env.BODY_LIMIT }));
  app.use(compression());

  // --- 4. Observability -----------------------------------------------------
  app.use(httpLogger);

  // --- 5. Routes ------------------------------------------------------------
  // Infra-facing health, outside the prefix and outside the rate limiter: a
  // throttled liveness probe is how a healthy container gets killed.
  app.use('/health', healthRouter);

  app.use(env.API_PREFIX, globalRateLimiter, apiRouter);

  // The admin panel: a self-contained static page served from the gateway itself.
  // Same origin as the API, so it needs no CORS entry and no separate deploy - the
  // operator just opens http://<server>/admin. `process.cwd()` because the process
  // runs from backend/ (see the `start` script), and `public/` is source, not
  // build output, so tsc never copies it into dist/.
  app.use('/admin', express.static(path.join(process.cwd(), 'public', 'admin')));

  // The public download page for the Android app. Separate from /admin because it
  // is the one page here meant for someone with no login: you send the link to
  // whoever is holding the phone. The APK itself stays where it has always been
  // (/admin/sms-gateway.apk), so every link already handed out keeps working - this
  // page just gives it a front door that says what the file is before 55MB starts
  // arriving on someone's mobile data.
  app.use('/download', express.static(path.join(process.cwd(), 'public', 'download')));

  app.get('/', (_req, res) => {
    res.json({
      success: true,
      data: { message: 'SMS Gateway API', docs: `${env.API_PREFIX}`, admin: '/admin', health: '/health' },
    });
  });

  // --- 6/7. Terminal handlers ----------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  log.debug('Express application constructed', {
    apiPrefix: env.API_PREFIX,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
  });

  return app;
}
