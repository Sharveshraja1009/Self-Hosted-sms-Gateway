import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';

import { env } from '../../config/env.js';
import { ErrorCode, UnauthorizedError } from '../../core/errors.js';
import type { Role, User } from '../../domain/user.js';

/**
 * Token issuance and verification.
 *
 * Two token types, two very different designs, for two different threat models:
 *
 * **Access token - a signed JWT, 15 minutes.**
 * Stateless: every request verifies it with a signature check and zero database
 * round-trips, which is what lets the API stay fast. The price of statelessness
 * is that it cannot be revoked - so we make it short-lived instead. A stolen
 * access token is worth 15 minutes, worst case.
 *
 * **Refresh token - an opaque random string, 30 days, stored hashed.**
 * Stateful, and therefore revocable. It is not a JWT and carries no claims:
 * there is nothing to decode, nothing to forge, and no algorithm-confusion
 * attack surface. We store only its SHA-256 digest, so a database dump yields no
 * working credentials.
 *
 * Rotation + reuse detection are implemented in auth.service.ts on top of this.
 */

export interface AccessTokenPayload {
  /** Subject: the user id. */
  sub: string;
  email: string;
  role: Role;
  /** Token type. Guards against a refresh token being replayed as an access token. */
  typ: 'access';
  /** Unique token id - useful for tracing and for a future denylist. */
  jti: string;
  iat: number;
  exp: number;
}

export interface IssuedAccessToken {
  token: string;
  /** Seconds until expiry - what an OAuth-shaped client expects. */
  expiresIn: number;
  expiresAt: Date;
}

export interface IssuedRefreshToken {
  /** The plaintext, returned to the client exactly once. */
  token: string;
  /** SHA-256 digest - the only form we persist. */
  tokenHash: string;
  expiresAt: Date;
}

/** "30d" / "15m" / "3600" -> milliseconds. */
function durationToMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)?$/.exec(duration);
  if (!match?.[1]) {
    throw new Error(`Invalid duration: "${duration}"`);
  }

  const value = Number(match[1]);
  const unit = match[2] ?? 's';

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  };

  return value * (multipliers[unit] ?? 1_000);
}

/** SHA-256, hex. Fast by design: unlike a password, the input has full entropy, so
 *  there is nothing to brute-force and no reason to pay bcrypt's cost per request. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const tokenService = {
  signAccessToken(user: Pick<User, 'id' | 'email' | 'role'>): IssuedAccessToken {
    const expiresInMs = durationToMs(env.JWT_ACCESS_TTL);

    const options: SignOptions = {
      expiresIn: Math.floor(expiresInMs / 1000),
      issuer: env.APP_NAME,
      audience: 'api',
      // Pin the algorithm. Never let the token's own header choose it - that is
      // the classic `alg: none` / HS-vs-RS confusion attack.
      algorithm: 'HS256',
    };

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, typ: 'access', jti: randomUUID() },
      env.JWT_ACCESS_SECRET,
      options,
    );

    return {
      token,
      expiresIn: Math.floor(expiresInMs / 1000),
      expiresAt: new Date(Date.now() + expiresInMs),
    };
  },

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'], // Reject anything not signed the way we sign.
        issuer: env.APP_NAME,
        audience: 'api',
      }) as AccessTokenPayload;

      // Belt and braces: a refresh token is not a JWT at all, but if we ever add
      // another JWT type, this stops it being replayed on the wrong endpoint.
      if (payload.typ !== 'access') {
        throw new UnauthorizedError('Wrong token type', ErrorCode.TOKEN_INVALID);
      }

      return payload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError('Access token has expired', ErrorCode.TOKEN_EXPIRED);
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedError('Access token is invalid', ErrorCode.TOKEN_INVALID);
      }
      throw error;
    }
  },

  /**
   * 256 bits from the CSPRNG. Not a JWT: an opaque bearer string whose only
   * meaning is "this row exists in the refresh_tokens table and is not revoked".
   */
  issueRefreshToken(): IssuedRefreshToken {
    const token = randomBytes(32).toString('base64url');
    const expiresInMs = durationToMs(env.JWT_REFRESH_TTL);

    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + expiresInMs),
    };
  },

  /** A new login starts a new token family - the unit we burn on theft detection. */
  newTokenFamily(): string {
    return randomUUID();
  },
};
