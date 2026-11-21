import { randomUUID } from 'node:crypto';

import type { ApiKey } from '../../domain/user.js';
import type { ApiKeyRepository, CreateApiKeyData } from '../types.js';

/** In-memory ApiKeyRepository. Lookup is by SHA-256 digest, never by plaintext. */

/** A free function, not a static method: safe to pass straight to `.map()`. */
function clone(key: ApiKey): ApiKey {
  return { ...key, scopes: [...key.scopes] };
}

export class InMemoryApiKeyRepository implements ApiKeyRepository {
  private readonly byId = new Map<string, ApiKey>();
  private readonly hashIndex = new Map<string, string>();

  create(data: CreateApiKeyData): Promise<ApiKey> {
    const key: ApiKey = {
      id: randomUUID(),
      userId: data.userId,
      name: data.name,
      keyHash: data.keyHash,
      keyPrefix: data.keyPrefix,
      scopes: [...data.scopes],
      isActive: true,
      expiresAt: data.expiresAt,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };

    this.byId.set(key.id, key);
    this.hashIndex.set(key.keyHash, key.id);

    return Promise.resolve(clone(key));
  }

  findByHash(keyHash: string): Promise<ApiKey | null> {
    const id = this.hashIndex.get(keyHash);
    if (!id) return Promise.resolve(null);

    const key = this.byId.get(id);
    return Promise.resolve(key ? clone(key) : null);
  }

  findById(id: string): Promise<ApiKey | null> {
    const key = this.byId.get(id);
    return Promise.resolve(key ? clone(key) : null);
  }

  listForUser(userId: string): Promise<ApiKey[]> {
    const keys = [...this.byId.values()]
      .filter((key) => key.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);

    return Promise.resolve(keys);
  }

  touchLastUsed(id: string, at: Date): Promise<void> {
    const key = this.byId.get(id);
    if (key) key.lastUsedAt = at;
    return Promise.resolve();
  }

  revoke(id: string): Promise<void> {
    const key = this.byId.get(id);
    if (key && key.revokedAt === null) {
      key.revokedAt = new Date();
      key.isActive = false;
    }
    return Promise.resolve();
  }

  clear(): void {
    this.byId.clear();
    this.hashIndex.clear();
  }
}
