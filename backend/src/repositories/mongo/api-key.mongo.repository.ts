import { randomUUID } from 'node:crypto';

import type { Collection, Db } from 'mongodb';

import type { ApiKey } from '../../domain/user.js';
import { Collections } from '../../infra/mongo.js';
import type { ApiKeyRepository, CreateApiKeyData } from '../types.js';
import type { ApiKeyDoc } from './documents.js';
import { toDomainApiKey } from './mappers.js';

/** MongoDB-backed ApiKeyRepository. Lookup is by SHA-256 digest; the plaintext is never stored. */
export class MongoApiKeyRepository implements ApiKeyRepository {
  private readonly keys: Collection<ApiKeyDoc>;

  constructor(db: Db) {
    this.keys = db.collection<ApiKeyDoc>(Collections.API_KEYS);
  }

  async create(data: CreateApiKeyData): Promise<ApiKey> {
    const doc: ApiKeyDoc = {
      _id: randomUUID(),
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

    await this.keys.insertOne(doc);

    return toDomainApiKey(doc);
  }

  async findByHash(keyHash: string): Promise<ApiKey | null> {
    const doc = await this.keys.findOne({ keyHash });
    return doc ? toDomainApiKey(doc) : null;
  }

  async findById(id: string): Promise<ApiKey | null> {
    const doc = await this.keys.findOne({ _id: id });
    return doc ? toDomainApiKey(doc) : null;
  }

  async listForUser(userId: string): Promise<ApiKey[]> {
    const docs = await this.keys.find({ userId }).sort({ createdAt: -1 }).toArray();
    return docs.map(toDomainApiKey);
  }

  async touchLastUsed(id: string, at: Date): Promise<void> {
    // updateOne with no result check, deliberately: this runs fire-and-forget on
    // the hot auth path. A key deleted in the microsecond between authenticating
    // and this write is not an error worth throwing into the void - the request
    // it belonged to has already been authorised on evidence that was valid when
    // it was read.
    await this.keys.updateOne({ _id: id }, { $set: { lastUsedAt: at } });
  }

  async revoke(id: string): Promise<void> {
    // Filtered on `revokedAt: null` for the same reason as refresh tokens:
    // revoking twice must not rewrite the timestamp of the first revocation.
    await this.keys.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date(), isActive: false } });
  }
}
