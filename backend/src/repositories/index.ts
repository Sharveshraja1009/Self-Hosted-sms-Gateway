import { createLogger } from '../core/logger.js';
import { InMemoryApiKeyRepository } from './memory/api-key.memory.repository.js';
import { InMemoryAuditLogRepository } from './memory/audit-log.memory.repository.js';
import { InMemoryCampaignRepository } from './memory/campaign.memory.repository.js';
import { InMemoryGatewayRepository } from './memory/gateway.memory.repository.js';
import { InMemoryMessageRepository } from './memory/message.memory.repository.js';
import { InMemoryRefreshTokenRepository } from './memory/refresh-token.memory.repository.js';
import { InMemoryUserRepository } from './memory/user.memory.repository.js';
import type { Repositories } from './types.js';

/**
 * The repository registry - a deliberately tiny dependency-injection seam.
 *
 * Services call `repositories()` at *call time*, not import time. That one detail
 * is what lets the composition root do this:
 *
 *     setRepositories(createMongoRepositories(db));
 *
 * ...and have every already-written service silently start talking to MongoDB.
 * No service imports a concrete store, so none of them need to change. Swapping
 * Postgres out for MongoDB touched this line and nothing in the service layer -
 * which is the receipt for the claim.
 *
 * It is also what lets each test start from a clean, isolated store without
 * spinning up a database.
 */

const log = createLogger('repositories');

export function createMemoryRepositories(): Repositories {
  return {
    users: new InMemoryUserRepository(),
    refreshTokens: new InMemoryRefreshTokenRepository(),
    apiKeys: new InMemoryApiKeyRepository(),
    auditLogs: new InMemoryAuditLogRepository(),
    gateways: new InMemoryGatewayRepository(),
    messages: new InMemoryMessageRepository(),
    campaigns: new InMemoryCampaignRepository(),
  };
}

let active: Repositories = createMemoryRepositories();

export function repositories(): Repositories {
  return active;
}

export function setRepositories(next: Repositories): void {
  active = next;
  log.info('Repository implementation swapped', { impl: next.users.constructor.name });
}

/** Test helper: fresh, empty stores for every suite. */
export function resetRepositories(): void {
  active = createMemoryRepositories();
}

export type { Repositories } from './types.js';
