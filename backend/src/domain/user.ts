/**
 * Domain entities for identity.
 *
 * These are plain data shapes with no dependency on Express, MongoDB or HTTP.
 * The service layer speaks in these types; the repository layer maps them to
 * whatever store is underneath (a Map in tests, MongoDB in production). Keeping
 * the domain free of persistence concerns is what makes that swap a no-op.
 */

export const Role = {
  /** Full control: users, gateways, settings, every message. */
  ADMIN: 'ADMIN',
  /** Can send SMS and see their own messages and gateways. */
  USER: 'USER',
  /** Read-only: dashboards and reports, no sending. */
  VIEWER: 'VIEWER',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: readonly Role[] = [Role.ADMIN, Role.USER, Role.VIEWER];

export interface User {
  id: string;
  email: string;
  /** bcrypt digest. Never leaves the repository layer. */
  passwordHash: string;
  name: string;
  role: Role;
  isActive: boolean;
  /** Per-user override of DEFAULT_DAILY_SMS_LIMIT. Enforced in Phase 4. */
  dailySmsLimit: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The only user shape allowed to cross an HTTP boundary.
 *
 * `passwordHash` is structurally absent rather than deleted at runtime, so a
 * future refactor that forgets to strip it fails to compile instead of leaking
 * every user's digest to the dashboard.
 */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  dailySmsLimit: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    dailySmsLimit: user.dailySmsLimit,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * A refresh token record.
 *
 * We store a SHA-256 digest, never the token itself: a database dump must not
 * hand an attacker working credentials.
 *
 * `family` is what makes theft detectable. Every rotation issues a new token in
 * the same family and revokes the old one. If a *revoked* token is ever presented
 * again, either the legitimate client replayed it or an attacker stole it - we
 * cannot tell which, so we assume the worst and kill the entire family.
 */
export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  family: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  /** Set when this token was rotated out, for forensics. */
  replacedByTokenId: string | null;
  userAgent: string | null;
  ip: string | null;
}

/** Coarse-grained capabilities an API key may carry. */
export const ApiKeyScope = {
  SMS_SEND: 'sms:send',
  SMS_READ: 'sms:read',
  /** Lets an Android device authenticate at POST /api/gateway/login (Phase 5). */
  GATEWAY_CONNECT: 'gateway:connect',
} as const;

export type ApiKeyScope = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

export const ALL_SCOPES: readonly ApiKeyScope[] = [
  ApiKeyScope.SMS_SEND,
  ApiKeyScope.SMS_READ,
  ApiKeyScope.GATEWAY_CONNECT,
];

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  /** SHA-256 of the full key. The plaintext is shown exactly once, at creation. */
  keyHash: string;
  /** Leading characters, e.g. "sk_a1b2c3d4" - for display and support ("which key is failing?"). */
  keyPrefix: string;
  scopes: ApiKeyScope[];
  isActive: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface PublicApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function toPublicApiKey(key: ApiKey): PublicApiKey {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    isActive: key.isActive && key.revokedAt === null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}
