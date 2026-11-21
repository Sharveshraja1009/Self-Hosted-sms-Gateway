import { env } from '../../config/env.js';
import { ConflictError, ErrorCode, UnauthorizedError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { AuditAction } from '../../domain/audit.js';
import { Role, toPublicUser, type PublicUser, type User } from '../../domain/user.js';
import { repositories } from '../../repositories/index.js';
import { auditService, type AuditContext } from '../audit/audit.service.js';
import { passwordService } from './password.service.js';
import { hashToken, tokenService } from './token.service.js';

/**
 * Authentication orchestration.
 *
 * Everything security-relevant about login lives here, and it is worth being
 * explicit about the two non-obvious decisions:
 *
 * 1. **Login leaks nothing.** Unknown email and wrong password produce the same
 *    error code, the same message, and - via `verifyDummy()` - the same latency.
 *    A disabled account is the one exception: telling a *legitimate* user their
 *    account is disabled is worth more than the enumeration risk, since they
 *    already proved they know the password.
 *
 * 2. **Refresh tokens rotate, and reuse is treated as theft.** Each refresh
 *    consumes its token and issues a new one in the same family. Presenting an
 *    already-revoked token means the token was captured and replayed - by an
 *    attacker, or by a legitimate client racing itself. We cannot tell the
 *    difference, so we assume the worst and revoke the whole family, forcing a
 *    fresh login. This is the standard OAuth 2.0 BCP mitigation, and it is the
 *    difference between "a stolen token is worth 30 days" and "a stolen token is
 *    worth until the victim's next refresh".
 */

const log = createLogger('auth');

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface AuthResult {
  user: PublicUser;
  tokens: AuthTokens;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

async function issueTokensFor(user: User, family: string, meta: RequestMeta): Promise<AuthTokens> {
  const access = tokenService.signAccessToken(user);
  const refresh = tokenService.issueRefreshToken();

  await repositories().refreshTokens.create({
    userId: user.id,
    tokenHash: refresh.tokenHash,
    family,
    expiresAt: refresh.expiresAt,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    tokenType: 'Bearer',
    expiresIn: access.expiresIn,
  };
}

export const authService = {
  /**
   * Registration.
   *
   * The very first account to register becomes ADMIN - the bootstrap problem has
   * to be solved somehow, and this beats shipping a default password or a seed
   * script people forget to run. Every subsequent account is a plain USER, and
   * an admin promotes them.
   */
  async register(
    input: { email: string; password: string; name: string },
    context: AuditContext,
  ): Promise<AuthResult> {
    const repos = repositories();
    const email = input.email.trim().toLowerCase();

    const existing = await repos.users.findByEmail(email);
    if (existing) {
      await auditService.failure(AuditAction.USER_REGISTERED, null, context, {
        email,
        reason: 'email_taken',
      });
      // Registration inherently reveals whether an email is taken - there is no
      // way around it without an email-confirmation flow. We at least rate-limit
      // this endpoint hard (10 / 15 min) so it is not a bulk enumeration oracle.
      throw new ConflictError('An account with that email already exists', ErrorCode.ALREADY_EXISTS);
    }

    const isFirstUser = (await repos.users.count()) === 0;

    const user = await repos.users.create({
      email,
      passwordHash: await passwordService.hash(input.password),
      name: input.name.trim(),
      role: isFirstUser ? Role.ADMIN : Role.USER,
      dailySmsLimit: env.DEFAULT_DAILY_SMS_LIMIT,
    });

    if (isFirstUser) {
      log.warn('First user registered - granted ADMIN role', { userId: user.id, email });
    }

    await auditService.success(AuditAction.USER_REGISTERED, user.id, context, {
      email,
      role: user.role,
      bootstrapAdmin: isFirstUser,
    });

    const tokens = await issueTokensFor(user, tokenService.newTokenFamily(), {
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { user: toPublicUser(user), tokens };
  },

  async login(input: { email: string; password: string }, context: AuditContext): Promise<AuthResult> {
    const repos = repositories();
    const email = input.email.trim().toLowerCase();

    const user = await repos.users.findByEmail(email);

    if (!user) {
      // Burn the same time a real bcrypt compare would, then fail identically.
      await passwordService.verifyDummy(input.password);
      await auditService.failure(AuditAction.LOGIN_FAILED, null, context, {
        email,
        reason: 'unknown_email',
      });
      throw new UnauthorizedError('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
    }

    const passwordMatches = await passwordService.verify(input.password, user.passwordHash);

    if (!passwordMatches) {
      await auditService.failure(AuditAction.LOGIN_FAILED, user.id, context, {
        email,
        reason: 'bad_password',
      });
      throw new UnauthorizedError('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      await auditService.failure(AuditAction.LOGIN_FAILED, user.id, context, {
        email,
        reason: 'account_disabled',
      });
      throw new UnauthorizedError('This account has been disabled', ErrorCode.ACCOUNT_DISABLED);
    }

    await repos.users.update(user.id, { lastLoginAt: new Date() });

    await auditService.success(AuditAction.LOGIN_SUCCEEDED, user.id, context, { email });

    const tokens = await issueTokensFor(user, tokenService.newTokenFamily(), {
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { user: toPublicUser(user), tokens };
  },

  /**
   * Refresh with rotation and reuse detection.
   *
   * The `revokedAt !== null` branch is the whole security story - read it closely.
   */
  async refresh(refreshToken: string, context: AuditContext): Promise<AuthResult> {
    const repos = repositories();
    const record = await repos.refreshTokens.findByHash(hashToken(refreshToken));

    if (!record) {
      await auditService.failure(AuditAction.TOKEN_REFRESHED, null, context, { reason: 'unknown_token' });
      throw new UnauthorizedError('Refresh token is invalid', ErrorCode.TOKEN_INVALID);
    }

    // --- Reuse detection -----------------------------------------------------
    // This token was already spent. Either an attacker stole it and is replaying
    // it, or the legitimate client is replaying it after we already rotated. We
    // cannot distinguish the two, so we assume compromise: every token descended
    // from this login dies, and both the attacker AND the victim are forced to
    // log in again. Inconveniencing the victim is the correct trade.
    if (record.revokedAt !== null) {
      const burned = await repos.refreshTokens.revokeFamily(record.family);

      log.error('Refresh token reuse detected - revoking entire token family', {
        userId: record.userId,
        family: record.family,
        tokensRevoked: burned,
        ip: context.ip,
      });

      await auditService.failure(AuditAction.TOKEN_REUSE_DETECTED, record.userId, context, {
        family: record.family,
        tokensRevoked: burned,
      });

      throw new UnauthorizedError(
        'Refresh token has already been used. All sessions have been revoked for your security.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      await auditService.failure(AuditAction.TOKEN_REFRESHED, record.userId, context, { reason: 'expired' });
      throw new UnauthorizedError('Refresh token has expired', ErrorCode.TOKEN_EXPIRED);
    }

    const user = await repos.users.findById(record.userId);

    if (!user || !user.isActive) {
      // The account was deleted or disabled while a valid token was outstanding.
      await repos.refreshTokens.revokeFamily(record.family);
      await auditService.failure(AuditAction.TOKEN_REFRESHED, record.userId, context, {
        reason: user ? 'account_disabled' : 'user_deleted',
      });
      throw new UnauthorizedError('This account is no longer active', ErrorCode.ACCOUNT_DISABLED);
    }

    // --- Rotate --------------------------------------------------------------
    // Same family, new token. The old one is spent from here on.
    const tokens = await issueTokensFor(user, record.family, {
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const successor = await repos.refreshTokens.findByHash(hashToken(tokens.refreshToken));
    await repos.refreshTokens.revoke(record.id, successor?.id ?? null);

    await auditService.success(AuditAction.TOKEN_REFRESHED, user.id, context, { family: record.family });

    return { user: toPublicUser(user), tokens };
  },

  /** Logs out one session (this device). Idempotent: an unknown token is not an error. */
  async logout(refreshToken: string, context: AuditContext): Promise<void> {
    const repos = repositories();
    const record = await repos.refreshTokens.findByHash(hashToken(refreshToken));

    if (record && record.revokedAt === null) {
      await repos.refreshTokens.revoke(record.id, null);
      await auditService.success(AuditAction.LOGOUT, record.userId, context, { scope: 'session' });
    }
  },

  /** "Log out everywhere" - the button a user hits after losing a phone. */
  async logoutAll(userId: string, context: AuditContext): Promise<{ sessionsRevoked: number }> {
    const revoked = await repositories().refreshTokens.revokeAllForUser(userId);
    await auditService.success(AuditAction.LOGOUT, userId, context, { scope: 'all', sessionsRevoked: revoked });
    return { sessionsRevoked: revoked };
  },

  /**
   * Password change.
   *
   * Requires the current password even though the caller is already
   * authenticated - that stops a stolen access token from being escalated into
   * permanent account takeover. On success every session is revoked, because the
   * whole point of changing a password is usually "someone else might have it".
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    context: AuditContext,
  ): Promise<{ sessionsRevoked: number }> {
    const repos = repositories();
    const user = await repos.users.findById(userId);

    if (!user) {
      throw new UnauthorizedError('Account not found', ErrorCode.UNAUTHORIZED);
    }

    const matches = await passwordService.verify(input.currentPassword, user.passwordHash);

    if (!matches) {
      await auditService.failure(AuditAction.PASSWORD_CHANGED, userId, context, { reason: 'bad_current_password' });
      throw new UnauthorizedError('Current password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }

    await repos.users.update(userId, {
      passwordHash: await passwordService.hash(input.newPassword),
    });

    const revoked = await repos.refreshTokens.revokeAllForUser(userId);

    await auditService.success(AuditAction.PASSWORD_CHANGED, userId, context, { sessionsRevoked: revoked });

    return { sessionsRevoked: revoked };
  },

  async me(userId: string): Promise<PublicUser> {
    const user = await repositories().users.findById(userId);

    if (!user) {
      throw new UnauthorizedError('Account not found', ErrorCode.UNAUTHORIZED);
    }

    return toPublicUser(user);
  },
};
