import { randomUUID } from 'node:crypto';

import type { Collection, Db } from 'mongodb';

import type { RefreshToken } from '../../domain/user.js';
import { Collections } from '../../infra/mongo.js';
import type { CreateRefreshTokenData, RefreshTokenRepository } from '../types.js';
import type { RefreshTokenDoc } from './documents.js';
import { toDomainRefreshToken } from './mappers.js';

/**
 * MongoDB-backed RefreshTokenRepository.
 *
 * Every `revoke*` method filters on `revokedAt: null`. That is not a
 * micro-optimisation - it is what makes them idempotent. Re-revoking a token
 * must not overwrite the original `revokedAt`, because that timestamp is the
 * evidence of *when* the token was legitimately rotated out, and the whole
 * theft-detection story is read off it afterwards.
 *
 * It is also why the counts returned here are `modifiedCount` and not
 * `matchedCount`: "how many live tokens did I just burn?" - a token that was
 * already dead was not burned by this call, and counting it would overstate the
 * blast radius of a theft in the audit trail.
 */
export class MongoRefreshTokenRepository implements RefreshTokenRepository {
  private readonly tokens: Collection<RefreshTokenDoc>;

  constructor(db: Db) {
    this.tokens = db.collection<RefreshTokenDoc>(Collections.REFRESH_TOKENS);
  }

  async create(data: CreateRefreshTokenData): Promise<RefreshToken> {
    const doc: RefreshTokenDoc = {
      _id: randomUUID(),
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

    await this.tokens.insertOne(doc);

    return toDomainRefreshToken(doc);
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const doc = await this.tokens.findOne({ tokenHash });
    return doc ? toDomainRefreshToken(doc) : null;
  }

  async revoke(id: string, replacedByTokenId: string | null): Promise<void> {
    await this.tokens.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date(), replacedByTokenId } });
  }

  async revokeFamily(family: string): Promise<number> {
    const result = await this.tokens.updateMany({ family, revokedAt: null }, { $set: { revokedAt: new Date() } });

    return result.modifiedCount;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.tokens.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });

    return result.modifiedCount;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.tokens.deleteMany({ expiresAt: { $lte: now } });
    return result.deletedCount;
  }

  async countActiveForUser(userId: string): Promise<number> {
    // "Active" means all three: belongs to the user, not revoked, not expired.
    // An expired-but-unrevoked token is not a session anyone can still use, so
    // counting it would tell the user they are logged in somewhere they are not.
    return this.tokens.countDocuments({
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
  }
}
