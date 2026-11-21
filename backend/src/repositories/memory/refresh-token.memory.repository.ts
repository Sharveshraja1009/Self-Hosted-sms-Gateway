import { randomUUID } from 'node:crypto';

import type { RefreshToken } from '../../domain/user.js';
import type { CreateRefreshTokenData, RefreshTokenRepository } from '../types.js';

/**
 * In-memory RefreshTokenRepository.
 *
 * The token *family* is the security-relevant structure here. Every refresh
 * rotates the token but keeps the family, so a stolen-and-replayed token can be
 * traced back to every descendant of the same login and all of them burned at
 * once. `revokeFamily` is that panic button.
 */
/** A free function, not a static method: safe to pass straight to `.map()`. */
function clone(token: RefreshToken): RefreshToken {
  return { ...token };
}

export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  private readonly byId = new Map<string, RefreshToken>();
  /** tokenHash -> id. Mirrors the UNIQUE index on the hash column. */
  private readonly hashIndex = new Map<string, string>();

  create(data: CreateRefreshTokenData): Promise<RefreshToken> {
    const token: RefreshToken = {
      id: randomUUID(),
      userId: data.userId,
      tokenHash: data.tokenHash,
      family: data.family,
      expiresAt: data.expiresAt,
      createdAt: new Date(),
      revokedAt: null,
      replacedByTokenId: null,
      userAgent: data.userAgent,
      ip: data.ip,
    };

    this.byId.set(token.id, token);
    this.hashIndex.set(token.tokenHash, token.id);

    return Promise.resolve(clone(token));
  }

  findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const id = this.hashIndex.get(tokenHash);
    if (!id) return Promise.resolve(null);

    const token = this.byId.get(id);
    return Promise.resolve(token ? clone(token) : null);
  }

  revoke(id: string, replacedByTokenId: string | null): Promise<void> {
    const token = this.byId.get(id);
    if (!token) return Promise.resolve();

    // Idempotent: re-revoking must not overwrite the original timestamp, which
    // is the evidence of *when* the token was legitimately rotated out.
    if (token.revokedAt === null) {
      token.revokedAt = new Date();
      token.replacedByTokenId = replacedByTokenId;
    }

    return Promise.resolve();
  }

  revokeFamily(family: string): Promise<number> {
    let revoked = 0;
    const now = new Date();

    for (const token of this.byId.values()) {
      if (token.family === family && token.revokedAt === null) {
        token.revokedAt = now;
        revoked += 1;
      }
    }

    return Promise.resolve(revoked);
  }

  revokeAllForUser(userId: string): Promise<number> {
    let revoked = 0;
    const now = new Date();

    for (const token of this.byId.values()) {
      if (token.userId === userId && token.revokedAt === null) {
        token.revokedAt = now;
        revoked += 1;
      }
    }

    return Promise.resolve(revoked);
  }

  deleteExpired(now: Date): Promise<number> {
    let deleted = 0;

    for (const [id, token] of this.byId.entries()) {
      if (token.expiresAt.getTime() <= now.getTime()) {
        this.byId.delete(id);
        this.hashIndex.delete(token.tokenHash);
        deleted += 1;
      }
    }

    return Promise.resolve(deleted);
  }

  countActiveForUser(userId: string): Promise<number> {
    const now = Date.now();
    let count = 0;

    for (const token of this.byId.values()) {
      if (token.userId === userId && token.revokedAt === null && token.expiresAt.getTime() > now) {
        count += 1;
      }
    }

    return Promise.resolve(count);
  }

  clear(): void {
    this.byId.clear();
    this.hashIndex.clear();
  }
}
