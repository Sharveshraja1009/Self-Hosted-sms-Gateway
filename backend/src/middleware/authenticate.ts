import type { NextFunction, Request, Response } from 'express';

import { ErrorCode, ForbiddenError, UnauthorizedError } from '../core/errors.js';
import { setContextValue } from '../core/request-context.js';
import { AuditAction } from '../domain/audit.js';
import type { ApiKeyScope, Role } from '../domain/user.js';
import { repositories } from '../repositories/index.js';
import { auditContextFrom, auditService } from '../modules/audit/audit.service.js';
import { apiKeyService } from '../modules/auth/api-key.service.js';
import { tokenService } from '../modules/auth/token.service.js';

/**
 * The authentication gate.
 *
 * Two credential types reach this API, and both land on the same `req.user`, so
 * every downstream handler is written once:
 *
 *  - `Authorization: Bearer <jwt>`  - humans in the dashboard. Stateless, fast.
 *  - `X-Api-Key: sk_...`            - machines: customer servers, the Android
 *                                     gateway, scripts. Stateful, revocable,
 *                                     scoped.
 *
 * Guards compose: `authenticate` proves *who*, `requireRole` / `requireScope`
 * prove *what they may do*. Keeping those separate is what stops a "gateway
 * connect" key from being usable to read every message in the account.
 */

/** Pulls a Bearer token out of the Authorization header, tolerating case and spacing. */
function extractBearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

function extractApiKey(req: Request): string | null {
  const header = req.get('x-api-key');
  if (header && header.trim().length > 0) return header.trim();

  // Also accept an API key presented as a Bearer credential. Integrators do this
  // constantly, and it costs us nothing to be liberal here: the `sk_` prefix
  // makes the two token types unambiguous.
  const bearer = extractBearerToken(req);
  return bearer?.startsWith('sk_') ? bearer : null;
}

/**
 * Requires a valid credential. Populates `req.user`, and `req.apiKey` when the
 * caller authenticated with a key.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    try {
      const apiKey = extractApiKey(req);

      if (apiKey) {
        const record = await apiKeyService.authenticate(apiKey);

        if (!record) {
          await auditService.failure(AuditAction.API_KEY_AUTH_FAILED, null, auditContextFrom(req), {
            // Only ever log the public prefix. Never the key.
            keyPrefix: apiKey.slice(0, 11),
          });
          throw new UnauthorizedError('API key is invalid, revoked or expired', ErrorCode.API_KEY_INVALID);
        }

        const owner = await repositories().users.findById(record.userId);

        // A key must not outlive its owner's access. Disabling a user has to
        // disable every machine credential they ever minted, or "disable account"
        // is a lie.
        if (!owner || !owner.isActive) {
          throw new UnauthorizedError('The account owning this API key is not active', ErrorCode.ACCOUNT_DISABLED);
        }

        req.user = { id: owner.id, email: owner.email, role: owner.role };
        req.apiKey = { id: record.id, scopes: record.scopes };

        setContextValue('userId', owner.id);
        next();
        return;
      }

      const bearer = extractBearerToken(req);

      if (!bearer) {
        throw new UnauthorizedError('Authentication required. Send an Authorization: Bearer token or an X-Api-Key header.');
      }

      // Throws UnauthorizedError with TOKEN_EXPIRED / TOKEN_INVALID as appropriate;
      // the dashboard branches on TOKEN_EXPIRED to trigger a silent refresh.
      const payload = tokenService.verifyAccessToken(bearer);

      req.user = { id: payload.sub, email: payload.email, role: payload.role };
      setContextValue('userId', payload.sub);

      next();
    } catch (error) {
      next(error);
    }
  })();
}

/**
 * Attaches `req.user` if a valid credential is present, but does not require one.
 * For endpoints that behave differently when signed in without demanding it.
 */
export function optionalAuthenticate(req: Request, res: Response, next: NextFunction): void {
  if (!req.get('authorization') && !req.get('x-api-key')) {
    next();
    return;
  }

  authenticate(req, res, (error?: unknown) => {
    // A bad credential on an optional route is simply "not signed in".
    next(error && !(error instanceof UnauthorizedError) ? error : undefined);
  });
}

/**
 * Role guard. Must run after `authenticate`.
 *
 *   router.get('/users', authenticate, requireRole(Role.ADMIN), controller.list);
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (!allowed.includes(req.user.role)) {
      void auditService.failure(AuditAction.ACCESS_DENIED, req.user.id, auditContextFrom(req), {
        path: req.originalUrl.split('?')[0],
        role: req.user.role,
        requiredRoles: allowed,
      });

      next(
        new ForbiddenError(
          `This action requires one of the following roles: ${allowed.join(', ')}`,
          ErrorCode.INSUFFICIENT_ROLE,
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Scope guard for API-key callers.
 *
 * A JWT-authenticated human is *not* scope-limited - their role already decides
 * what they can do, and scopes exist to narrow machine credentials below their
 * owner's authority. So this guard only bites when `req.apiKey` is present.
 */
export function requireScope(scope: ApiKeyScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (!req.apiKey) {
      next();
      return;
    }

    if (!req.apiKey.scopes.includes(scope)) {
      next(
        new ForbiddenError(
          `This API key does not carry the "${scope}" scope`,
          ErrorCode.INSUFFICIENT_ROLE,
        ),
      );
      return;
    }

    next();
  };
}
