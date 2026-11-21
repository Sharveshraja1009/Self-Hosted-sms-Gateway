import { MongoClient, type Db } from 'mongodb';

import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { onShutdown } from '../core/shutdown.js';
import { healthRegistry } from '../modules/health/health.registry.js';

/**
 * The MongoDB connection.
 *
 * One MongoClient for the whole process. This is not premature optimisation:
 * the client owns a connection pool, and constructing one per request would
 * open a socket per request and exhaust the server's connection limit under any
 * real load - a failure mode that only ever shows up in production.
 *
 * Slow-command logging is wired to Winston rather than stdout, so a query that
 * starts degrading appears in the same stream as everything else. We log the
 * command *name* and collection, never the command body: it would contain
 * password hashes, token digests and OTPs.
 */

const log = createLogger('mongo');

/** Anything slower than this is worth a warning: it is a missing index until proven otherwise. */
const SLOW_COMMAND_MS = 500;

/** Commands that say nothing about query performance and would just be noise. */
const IGNORED_COMMANDS = new Set(['ping', 'hello', 'ismaster', 'endSessions', 'createIndexes']);

export const mongoClient = new MongoClient(env.MONGODB_URI, {
  // monitorCommands is what makes the slow-command log below possible. It costs
  // an event emit per command - negligible next to a network round-trip.
  monitorCommands: true,
  // Fail fast when the server is unreachable. The default (30s) means a boot
  // against a dead database hangs for half a minute before saying so.
  serverSelectionTimeoutMS: 5_000,
  maxPoolSize: 20,
  minPoolSize: 2,
  // Retry a write once on a transient network blip. Safe because every write in
  // this codebase is idempotent or single-document.
  retryWrites: true,
});

mongoClient.on('commandSucceeded', (event) => {
  if (IGNORED_COMMANDS.has(event.commandName)) return;

  if (event.duration >= SLOW_COMMAND_MS) {
    log.warn('Slow command', { durationMs: event.duration, command: event.commandName });
  } else {
    log.debug('Command', { durationMs: event.duration, command: event.commandName });
  }
});

mongoClient.on('commandFailed', (event) => {
  if (IGNORED_COMMANDS.has(event.commandName)) return;
  log.error('Command failed', { command: event.commandName, durationMs: event.duration });
});

export const mongoDb = (): Db => mongoClient.db(env.MONGODB_DB);

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/**
 * Collection names, in one place - so a typo is a compile error rather than a
 * silently-created empty collection, which is what a bare string literal buys
 * you in a schemaless database.
 */
export const Collections = {
  USERS: 'users',
  REFRESH_TOKENS: 'refresh_tokens',
  API_KEYS: 'api_keys',
  AUDIT_LOGS: 'audit_logs',
  GATEWAYS: 'gateways',
  MESSAGES: 'messages',
  CAMPAIGNS: 'campaigns',
} as const;

/**
 * Declares every index the application depends on.
 *
 * This is the MongoDB equivalent of a migration, and it is deliberately code
 * rather than a schema file: `createIndex` is idempotent, so running it on every
 * boot is safe, and it means a fresh database is *correct* the moment the server
 * starts. There is no "did anyone remember to run the migration?" step.
 *
 * The unique indexes are not decoration. `users.email` is what makes concurrent
 * registration safe - see the comment in user.mongo.repository.ts. Without it,
 * two simultaneous signups for the same address both succeed.
 *
 * Every index here exists because a real query needs it. An index you cannot
 * name a query for is dead weight on every insert.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  const startedAt = Date.now();

  await Promise.all([
    // Registration and login both resolve an account by address, and the UNIQUE
    // constraint is the race arbiter on the signup path.
    db.collection(Collections.USERS).createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' }),

    // Refresh: look the presented token up by its digest. UNIQUE because a
    // digest collision would mean two sessions sharing one credential.
    db
      .collection(Collections.REFRESH_TOKENS)
      .createIndex({ tokenHash: 1 }, { unique: true, name: 'refresh_tokens_hash_unique' }),
    // "Log out everywhere" and the active-session count.
    db.collection(Collections.REFRESH_TOKENS).createIndex({ userId: 1 }, { name: 'refresh_tokens_user' }),
    // Theft detection: burn every token descended from one login.
    db.collection(Collections.REFRESH_TOKENS).createIndex({ family: 1 }, { name: 'refresh_tokens_family' }),
    // The sweep of dead rows.
    db.collection(Collections.REFRESH_TOKENS).createIndex({ expiresAt: 1 }, { name: 'refresh_tokens_expiry' }),

    // API-key auth: one indexed lookup by SHA-256 digest on every machine request.
    db.collection(Collections.API_KEYS).createIndex({ keyHash: 1 }, { unique: true, name: 'api_keys_hash_unique' }),
    db.collection(Collections.API_KEYS).createIndex({ userId: 1, createdAt: -1 }, { name: 'api_keys_user' }),

    // The audit views: by user, by action, and the unfiltered newest-first list.
    db.collection(Collections.AUDIT_LOGS).createIndex({ userId: 1, createdAt: -1 }, { name: 'audit_user' }),
    db.collection(Collections.AUDIT_LOGS).createIndex({ action: 1, createdAt: -1 }, { name: 'audit_action' }),
    db.collection(Collections.AUDIT_LOGS).createIndex({ createdAt: -1 }, { name: 'audit_recent' }),

    // A phone is identified by its deviceId, and the upsert in register() relies
    // on this being UNIQUE: without it, two racing reconnects create two gateway
    // records for one handset, and half the dispatches go to a dead socket.
    db.collection(Collections.GATEWAYS).createIndex({ deviceId: 1 }, { unique: true, name: 'gateways_device_unique' }),
    // The dispatch query: "which of my devices can take this message right now?"
    db.collection(Collections.GATEWAYS).createIndex({ userId: 1, status: 1 }, { name: 'gateways_user_status' }),

    // The dashboard's main list: "my messages, newest first".
    db.collection(Collections.MESSAGES).createIndex({ userId: 1, createdAt: -1 }, { name: 'messages_user' }),
    // Draining the queue when a device connects: "my oldest QUEUED messages".
    db.collection(Collections.MESSAGES).createIndex({ userId: 1, status: 1, queuedAt: 1 }, { name: 'messages_queued' }),
    // "Did my message to this number go through?"
    db.collection(Collections.MESSAGES).createIndex({ recipient: 1 }, { name: 'messages_recipient' }),

    // The campaigns list: "my campaigns, newest first".
    db.collection(Collections.CAMPAIGNS).createIndex({ userId: 1, createdAt: -1 }, { name: 'campaigns_user' }),
    // The runner's poll: "every RUNNING campaign, so I can advance it". Scoped by
    // status across all users because the runner is a background worker, not a request.
    db.collection(Collections.CAMPAIGNS).createIndex({ status: 1, createdAt: 1 }, { name: 'campaigns_status' }),
  ]);

  log.info('Indexes ensured', { durationMs: Date.now() - startedAt });
}

/**
 * Connects, creates indexes, registers the readiness probe and arms the
 * shutdown hook.
 *
 * Called once from the composition root, *before* the HTTP listener opens - so
 * the server never accepts a request it cannot serve.
 */
export async function connectMongo(): Promise<Db> {
  const startedAt = Date.now();

  await mongoClient.connect();
  const db = mongoDb();

  // connect() resolves once the pool exists; it does not prove the server will
  // answer. A ping does.
  await db.command({ ping: 1 });

  log.info('Connected to MongoDB', { database: env.MONGODB_DB, durationMs: Date.now() - startedAt });

  await ensureIndexes(db);

  // `ping` is the cheapest possible proof that the pool can still hand out a
  // working connection. It touches no collection, so it stays honest.
  healthRegistry.register(
    'mongo',
    async () => {
      await db.command({ ping: 1 });
    },
    { critical: true, timeoutMs: 2_000 },
  );

  // Priority 10: below the HTTP server (100), so the listener stops accepting
  // before we pull the database out from under any in-flight request.
  onShutdown(
    'mongo',
    async () => {
      await mongoClient.close();
    },
    10,
  );

  return db;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * MongoDB server error codes we care about by name.
 * @see https://www.mongodb.com/docs/manual/reference/error-codes/
 */
export const MongoErrorCode = {
  DUPLICATE_KEY: 11000,
} as const;

/**
 * Did this error come from a unique index rejecting a write?
 *
 * The driver throws a `MongoServerError` carrying `code: 11000`. We narrow
 * structurally rather than with `instanceof`, because the error can arrive from
 * a bulk write wrapped in a different class, and an `instanceof` check that
 * silently stops matching would turn a handled conflict into a 500.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === MongoErrorCode.DUPLICATE_KEY
  );
}
