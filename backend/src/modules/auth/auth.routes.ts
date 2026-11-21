import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import { authController } from './auth.controller.js';
import {
  apiKeyIdSchema,
  changePasswordSchema,
  createApiKeySchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from './auth.schemas.js';

/**
 * Auth routes.
 *
 * The middleware chain on each line reads as a sentence: throttle it, validate
 * it, authenticate it, then handle it. Anything missing from a chain is a
 * deliberate absence, not an oversight:
 *
 *  - `/login`, `/register`, `/refresh` are unauthenticated by definition, and so
 *    they carry `authRateLimiter` (10 attempts / 15 min / IP) instead. That is
 *    the only thing standing between a weak password and an offline-speed
 *    credential-stuffing run.
 *  - `/refresh` is rate-limited too: a stolen refresh token should not be
 *    grindable, and reuse detection means a *wrong* guess costs the attacker the
 *    whole family.
 *  - `/logout` needs no auth. The refresh token in the body IS the credential,
 *    and letting a user with an expired access token still sign out cleanly is
 *    correct behaviour.
 *
 * Note on CSRF: this API is Bearer-token authenticated and sets no cookies, so a
 * browser cannot be tricked into authenticating a cross-site request on the
 * user's behalf - there is no ambient credential to ride. CSRF tokens would be
 * pure ceremony here. If a future phase moves refresh tokens into cookies, this
 * comment becomes a bug and CSRF protection becomes mandatory.
 */
export const authRouter: Router = Router();

// --- Public ----------------------------------------------------------------
authRouter.post('/register', authRateLimiter, validate({ body: registerSchema }), authController.register);
authRouter.post('/login', authRateLimiter, validate({ body: loginSchema }), authController.login);
authRouter.post('/refresh', authRateLimiter, validate({ body: refreshSchema }), authController.refresh);
authRouter.post('/logout', validate({ body: logoutSchema }), authController.logout);

// --- Authenticated ---------------------------------------------------------
authRouter.get('/me', authenticate, authController.me);
authRouter.post('/logout-all', authenticate, authController.logoutAll);
authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  authController.changePassword,
);

// --- API key management ----------------------------------------------------
authRouter.get('/api-keys', authenticate, authController.listApiKeys);
authRouter.post('/api-keys', authenticate, validate({ body: createApiKeySchema }), authController.createApiKey);
authRouter.delete(
  '/api-keys/:id',
  authenticate,
  validate({ params: apiKeyIdSchema }),
  authController.revokeApiKey,
);
