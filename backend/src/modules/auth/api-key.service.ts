import { randomBytes } from 'node:crypto';

import { ForbiddenError, NotFoundError } from '../../core/errors.js';
import { type ApiKey, type ApiKeyScope, toPublicApiKey, type PublicApiKey } from '../../domain/user.js';
import { repositories } from '../../repositories/index.js';
import { hashToken } from './token.service.js';

/**
 * API keys - credentials for machines, not humans.
 *
 * Three consumers:
 *  - A customer's server calling POST /api/messages/send (Phase 4).
 *  - The Android gateway app authenticating at POST /api/gateway/login (Phase 5).
 *  - Scripts and integrations that cannot perform an interactive login.
 *
 * Design rules, all of them non-negotiable:
 *  - The plaintext is generated once, returned once, and never stored. If the
 *    user loses it, they issue a new one. We *cannot* recover it, by design.
 *  - Only a SHA-256 digest is persisted, so a database dump is inert.
 *  - A visible prefix is stored for support ("key sk_a1b2c3d4 is 401ing") without
 *    exposing anything secret.
 *  - Scopes are checked at the route, so a gateway key cannot be used to read
 *    every message in the account.
 */

const KEY_PREFIX = 'sk_';
/** 32 random bytes -> 43 base64url chars. Guessing is not a viable attack. */
const KEY_BYTES = 32;
/** How much of the key we keep in the clear for identification. */
const DISPLAY_PREFIX_LENGTH = 11;

export interface CreatedApiKey {
  key: PublicApiKey;
  /** THE ONE AND ONLY TIME this value exists outside the client's hands. */
  plaintext: string;
}

export const apiKeyService = {
  async create(params: {
    userId: string;
    name: string;
    scopes: ApiKeyScope[];
    expiresAt: Date | null;
  }): Promise<CreatedApiKey> {
    const plaintext = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;

    const created = await repositories().apiKeys.create({
      userId: params.userId,
      name: params.name,
      keyHash: hashToken(plaintext),
      keyPrefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
      scopes: params.scopes,
      expiresAt: params.expiresAt,
    });

    return { key: toPublicApiKey(created), plaintext };
  },

  /**
   * Resolves a presented key to its record, or null.
   *
   * Returns null - never throws - for every failure mode (unknown, revoked,
   * expired). The caller decides what to do, and crucially logs them all the same
   * way, so the API cannot be used to distinguish "this key never existed" from
   * "this key was revoked yesterday".
   */
  async authenticate(plaintext: string): Promise<ApiKey | null> {
    if (!plaintext.startsWith(KEY_PREFIX)) return null;

    const record = await repositories().apiKeys.findByHash(hashToken(plaintext));
    if (!record) return null;

    if (!record.isActive || record.revokedAt !== null) return null;
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return null;

    // Fire-and-forget: "last used" is a nice-to-have, not worth adding latency
    // to every authenticated request, and definitely not worth failing one over.
    void repositories().apiKeys.touchLastUsed(record.id, new Date());

    return record;
  },

  async listForUser(userId: string): Promise<PublicApiKey[]> {
    const keys = await repositories().apiKeys.listForUser(userId);
    return keys.map(toPublicApiKey);
  },

  async revoke(userId: string, keyId: string): Promise<void> {
    const key = await repositories().apiKeys.findById(keyId);

    if (!key) {
      throw new NotFoundError('API key');
    }

    // Ownership check. Without it, any authenticated user could revoke any other
    // user's keys by guessing a UUID - a trivial denial of service.
    if (key.userId !== userId) {
      throw new ForbiddenError('You do not own this API key');
    }

    await repositories().apiKeys.revoke(keyId);
  },

  hasScope(key: ApiKey, scope: ApiKeyScope): boolean {
    return key.scopes.includes(scope);
  },
};
