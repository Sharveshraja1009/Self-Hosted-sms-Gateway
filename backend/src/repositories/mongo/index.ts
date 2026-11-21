import type { Db } from 'mongodb';

import type { Repositories } from '../types.js';
import { MongoApiKeyRepository } from './api-key.mongo.repository.js';
import { MongoAuditLogRepository } from './audit-log.mongo.repository.js';
import { MongoCampaignRepository } from './campaign.mongo.repository.js';
import { MongoGatewayRepository } from './gateway.mongo.repository.js';
import { MongoMessageRepository } from './message.mongo.repository.js';
import { MongoRefreshTokenRepository } from './refresh-token.mongo.repository.js';
import { MongoUserRepository } from './user.mongo.repository.js';

/**
 * The MongoDB-backed implementation of every repository port.
 *
 * This function is the entire cost of the store swap. The composition root
 * calls:
 *
 *     setRepositories(createMongoRepositories(db));
 *
 * ...and every service written in Phase 2 - auth, audit, API keys - starts
 * talking to MongoDB. Not one line of business logic changed; not one service
 * imports anything from this folder. That property is the whole reason the ports
 * exist, and the contract suite (which runs the same assertions against the Maps
 * and against a real database) is the proof that it held.
 */
export function createMongoRepositories(db: Db): Repositories {
  return {
    users: new MongoUserRepository(db),
    refreshTokens: new MongoRefreshTokenRepository(db),
    apiKeys: new MongoApiKeyRepository(db),
    auditLogs: new MongoAuditLogRepository(db),
    gateways: new MongoGatewayRepository(db),
    messages: new MongoMessageRepository(db),
    campaigns: new MongoCampaignRepository(db),
  };
}
