import type { Request, Response } from 'express';

import { UnauthorizedError } from '../../core/errors.js';
import { sendCreated, sendSuccess } from '../../core/http-response.js';
import { validatedBody, validatedParams } from '../../middleware/validate.js';
import { auditContextFrom } from '../audit/audit.service.js';
import { apiKeyService } from './api-key.service.js';
import { authService } from './auth.service.js';
import type {
  ApiKeyIdParams,
  ChangePasswordInput,
  CreateApiKeyInput,
  LoginInput,
  LogoutInput,
  RefreshInput,
  RegisterInput,
} from './auth.schemas.js';

/**
 * HTTP adapter for the auth module.
 *
 * Input arrives pre-validated on `req.validated` (the `validate()` middleware ran
 * first), so nothing here re-checks shapes. The only job is: unwrap, delegate,
 * respond.
 */

/** `authenticate` guarantees req.user, but TypeScript can't see that across middleware. */
function requireUser(req: Request): { id: string; email: string } {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }
  return req.user;
}

export const authController = {
  register: async (req: Request, res: Response): Promise<void> => {
    const result = await authService.register(validatedBody<RegisterInput>(req), auditContextFrom(req));
    sendCreated(res, result);
  },

  login: async (req: Request, res: Response): Promise<void> => {
    const result = await authService.login(validatedBody<LoginInput>(req), auditContextFrom(req));
    sendSuccess(res, result);
  },

  refresh: async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = validatedBody<RefreshInput>(req);
    const result = await authService.refresh(refreshToken, auditContextFrom(req));
    sendSuccess(res, result);
  },

  logout: async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = validatedBody<LogoutInput>(req);
    await authService.logout(refreshToken, auditContextFrom(req));
    // Always 200, even for an unknown token. Logging out is idempotent, and a
    // 404 here would let anyone probe which refresh tokens exist.
    sendSuccess(res, { message: 'Logged out' });
  },

  logoutAll: async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(req);
    const result = await authService.logoutAll(user.id, auditContextFrom(req));
    sendSuccess(res, { message: 'Logged out of all sessions', ...result });
  },

  me: async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(req);
    sendSuccess(res, await authService.me(user.id));
  },

  changePassword: async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(req);
    const result = await authService.changePassword(
      user.id,
      validatedBody<ChangePasswordInput>(req),
      auditContextFrom(req),
    );
    sendSuccess(res, { message: 'Password changed. All other sessions have been signed out.', ...result });
  },

  // --- API keys ------------------------------------------------------------

  createApiKey: async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(req);
    const input = validatedBody<CreateApiKeyInput>(req);

    const { key, plaintext } = await apiKeyService.create({
      userId: user.id,
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
    });

    sendCreated(res, {
      ...key,
      // The only response that will ever contain this value.
      plaintext,
      warning: 'Store this key now. It cannot be retrieved again.',
    });
  },

  listApiKeys: async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(req);
    sendSuccess(res, await apiKeyService.listForUser(user.id));
  },

  revokeApiKey: async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(req);
    const { id } = validatedParams<ApiKeyIdParams>(req);

    await apiKeyService.revoke(user.id, id);
    sendSuccess(res, { message: 'API key revoked' });
  },
};
