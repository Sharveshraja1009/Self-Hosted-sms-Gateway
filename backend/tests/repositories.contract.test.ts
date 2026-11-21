import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { Role } from '../src/domain/user.js';
import { AuditAction } from '../src/domain/audit.js';
import { Collections, ensureIndexes } from '../src/infra/mongo.js';
import { createMemoryRepositories } from '../src/repositories/index.js';
import { createMongoRepositories } from '../src/repositories/mongo/index.js';
import type { Repositories } from '../src/repositories/types.js';

/**
 * The repository CONTRACT suite.
 *
 * This is the test that makes the architecture's central claim checkable rather
 * than merely asserted: *the in-memory store and the MongoDB store are
 * interchangeable*. Every assertion below runs twice - once against Maps, once
 * against a real database - from a single body of code.
 *
 * If the two implementations ever diverge (Mongo enforces a unique index the Map
 * forgot; the Map returns `undefined` where the driver returns `null`; one mints
 * a UUID and the other an ObjectId), this suite goes red. Without it, "we can
 * swap the store" is a comment, not a fact - and you find out it was a lie on the
 * day you deploy.
 *
 * The Mongo half is NOT skippable, and that is the point. If it only ran when a
 * developer happened to have Docker up, then the store nobody runs locally is
 * exactly the store that rots - and the contract would be verified on precisely
 * the machines that needed it least. So:
 *
 *   1. If a real MongoDB is reachable (the compose stack, or CI), use it.
 *   2. Otherwise download and boot an ephemeral in-process `mongod`.
 *
 * Either way, a real mongod answers every query below. The ephemeral binary is
 * cached after the first run, so this costs a one-time download and about a
 * second per suite thereafter.
 */

const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI ?? process.env.MONGODB_URI;
const TEST_MONGODB_DB = process.env.TEST_MONGODB_DB ?? process.env.MONGODB_DB ?? 'smsgw_test';

interface Harness {
  db: Db;
  /** How this database was obtained, for the one line we print at startup. */
  label: string;
  stop: () => Promise<void>;
}

/** A real server, if the environment points at one that answers. */
async function connectToExternal(): Promise<Harness | null> {
  if (!TEST_MONGODB_URI) return null;

  // A short timeout: when nothing is listening we want to fall through to the
  // ephemeral server in a second, not stall for the default 30.
  const client = new MongoClient(TEST_MONGODB_URI, { serverSelectionTimeoutMS: 1_500 });

  try {
    await client.connect();
    const db = client.db(TEST_MONGODB_DB);
    await db.command({ ping: 1 });

    return {
      db,
      label: `external (${TEST_MONGODB_DB})`,
      stop: () => client.close(),
    };
  } catch {
    await client.close().catch(() => undefined);
    return null;
  }
}

/** A real mongod, downloaded once and run in-process. No Docker required. */
async function startEphemeral(): Promise<Harness | null> {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create();

    const client = new MongoClient(server.getUri());
    await client.connect();

    return {
      db: client.db(TEST_MONGODB_DB),
      label: 'ephemeral in-process mongod',
      stop: async () => {
        await client.close();
        await server.stop();
      },
    };
  } catch (error) {
    console.warn(
      '\n  ⚠  Could not start an ephemeral MongoDB, so the contract suite is running against' +
        '\n     the in-memory store ONLY - the MongoDB repositories are going unverified.' +
        `\n     Reason: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

const mongo = (await connectToExternal()) ?? (await startEphemeral());

if (mongo) {
  // The indexes must exist before a single assertion runs. Their absence would
  // not fail loudly - it would just make every uniqueness assertion below
  // silently untrue, which is far worse than a red test.
  await ensureIndexes(mongo.db);
  console.warn(`\n  ▸ Repository contract: MongoDB half running against ${mongo.label}.\n`);
}

interface Implementation {
  name: string;
  create: () => Repositories;
  reset: () => Promise<void>;
}

const implementations: Implementation[] = [
  {
    name: 'in-memory',
    create: createMemoryRepositories,
    reset: () => Promise.resolve(),
  },
];

if (mongo) {
  const { db } = mongo;

  implementations.push({
    name: 'mongo',
    create: () => createMongoRepositories(db),
    // deleteMany, not dropCollection: dropping a collection takes its indexes
    // with it, and every subsequent test would then run without the unique
    // constraint - quietly passing assertions that ought to fail.
    reset: async () => {
      await Promise.all([
        db.collection(Collections.AUDIT_LOGS).deleteMany({}),
        db.collection(Collections.REFRESH_TOKENS).deleteMany({}),
        db.collection(Collections.API_KEYS).deleteMany({}),
        db.collection(Collections.USERS).deleteMany({}),
        db.collection(Collections.GATEWAYS).deleteMany({}),
        db.collection(Collections.MESSAGES).deleteMany({}),
        db.collection(Collections.CAMPAIGNS).deleteMany({}),
      ]);
    },
  });
}

afterAll(async () => {
  await mongo?.stop();
});

describe.each(implementations)('repository contract [$name]', (impl) => {
  let repos: Repositories;

  beforeEach(async () => {
    await impl.reset();
    repos = impl.create();
  });

  const newUser = (email = 'contract@example.com') => ({
    email,
    passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
    name: 'Contract Test',
    role: Role.USER,
    dailySmsLimit: 100,
  });

  // -------------------------------------------------------------------------
  describe('users', () => {
    it('round-trips a user', async () => {
      const created = await repos.users.create(newUser());

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.email).toBe('contract@example.com');
      expect(created.isActive).toBe(true);
      expect(created.createdAt).toBeInstanceOf(Date);

      const found = await repos.users.findById(created.id);
      expect(found).toMatchObject({ id: created.id, email: created.email });
    });

    it('returns null - not undefined, not a throw - for a missing user', async () => {
      expect(await repos.users.findById('11111111-1111-4111-8111-111111111111')).toBeNull();
      expect(await repos.users.findByEmail('nobody@example.com')).toBeNull();
    });

    it('enforces email uniqueness', async () => {
      await repos.users.create(newUser());
      await expect(repos.users.create(newUser())).rejects.toThrow(/already exists/i);
    });

    it('normalises email case and whitespace on write AND on read', async () => {
      const created = await repos.users.create(newUser('  MiXeD@Example.COM  '));
      expect(created.email).toBe('mixed@example.com');

      // Both stores must resolve any casing to the same row.
      expect(await repos.users.findByEmail('MIXED@EXAMPLE.COM')).toMatchObject({ id: created.id });
      expect(await repos.users.findByEmail('mixed@example.com')).toMatchObject({ id: created.id });
    });

    it('applies a partial update without clobbering untouched fields', async () => {
      const created = await repos.users.create(newUser());

      const updated = await repos.users.update(created.id, { name: 'Renamed' });

      expect(updated.name).toBe('Renamed');
      expect(updated.email).toBe(created.email);
      expect(updated.role).toBe(created.role);
      expect(updated.passwordHash).toBe(created.passwordHash);
    });

    it('throws NotFound when updating a user that does not exist', async () => {
      await expect(repos.users.update('11111111-1111-4111-8111-111111111111', { name: 'Ghost' })).rejects.toThrow(
        /not found/i,
      );
    });

    it('paginates newest-first', async () => {
      for (let i = 0; i < 5; i += 1) {
        await repos.users.create(newUser(`user${i}@example.com`));
      }

      const page1 = await repos.users.list({ page: 1, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page3 = await repos.users.list({ page: 3, limit: 2 });
      expect(page3.items).toHaveLength(1);

      // No overlap between pages.
      const ids = new Set([...page1.items, ...page3.items].map((u) => u.id));
      expect(ids.size).toBe(3);
    });

    it('counts users (the ADMIN-bootstrap check depends on this)', async () => {
      expect(await repos.users.count()).toBe(0);
      await repos.users.create(newUser());
      expect(await repos.users.count()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('refresh tokens', () => {
    async function seedToken(family = '22222222-2222-4222-8222-222222222222', hash = 'hash-a') {
      const user = await repos.users.create(newUser(`${hash}@example.com`));

      const token = await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: hash,
        family,
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: 'vitest',
        ip: '127.0.0.1',
      });

      return { user, token };
    }

    it('round-trips by hash', async () => {
      const { token } = await seedToken();

      const found = await repos.refreshTokens.findByHash('hash-a');
      expect(found).toMatchObject({ id: token.id, revokedAt: null, family: token.family });
    });

    it('revoke() is idempotent - it must not overwrite the original timestamp', async () => {
      const { token } = await seedToken();

      await repos.refreshTokens.revoke(token.id, null);
      const first = await repos.refreshTokens.findByHash('hash-a');

      await new Promise((resolve) => setTimeout(resolve, 5));
      await repos.refreshTokens.revoke(token.id, null);
      const second = await repos.refreshTokens.findByHash('hash-a');

      // The revokedAt of a token is evidence of when it was spent. Re-revoking
      // must not rewrite that evidence.
      expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
    });

    it('revokeFamily() burns every live token in the family and reports the count', async () => {
      const family = '33333333-3333-4333-8333-333333333333';
      const { user } = await seedToken(family, 'fam-1');

      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: 'fam-2',
        family,
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ip: null,
      });

      const burned = await repos.refreshTokens.revokeFamily(family);
      expect(burned).toBe(2);

      expect((await repos.refreshTokens.findByHash('fam-1'))?.revokedAt).not.toBeNull();
      expect((await repos.refreshTokens.findByHash('fam-2'))?.revokedAt).not.toBeNull();

      // Already-revoked tokens are not counted a second time.
      expect(await repos.refreshTokens.revokeFamily(family)).toBe(0);
    });

    it('revokeAllForUser() ends every session', async () => {
      const { user } = await seedToken('44444444-4444-4444-8444-444444444444', 'all-1');

      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: 'all-2',
        family: '55555555-5555-4555-8555-555555555555',
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ip: null,
      });

      expect(await repos.refreshTokens.countActiveForUser(user.id)).toBe(2);
      expect(await repos.refreshTokens.revokeAllForUser(user.id)).toBe(2);
      expect(await repos.refreshTokens.countActiveForUser(user.id)).toBe(0);
    });

    it('deleteExpired() removes dead rows and leaves live ones alone', async () => {
      const user = await repos.users.create(newUser('expiry@example.com'));

      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: 'dead',
        family: '66666666-6666-4666-8666-666666666666',
        expiresAt: new Date(Date.now() - 1_000),
        userAgent: null,
        ip: null,
      });
      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: 'alive',
        family: '77777777-7777-4777-8777-777777777777',
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ip: null,
      });

      expect(await repos.refreshTokens.deleteExpired(new Date())).toBe(1);
      expect(await repos.refreshTokens.findByHash('dead')).toBeNull();
      expect(await repos.refreshTokens.findByHash('alive')).not.toBeNull();
    });

    it('does not count an expired token as an active session', async () => {
      const user = await repos.users.create(newUser('stale@example.com'));

      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: 'stale',
        family: '88888888-8888-4888-8888-888888888888',
        expiresAt: new Date(Date.now() - 1_000),
        userAgent: null,
        ip: null,
      });

      expect(await repos.refreshTokens.countActiveForUser(user.id)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('api keys', () => {
    async function seedKey() {
      const user = await repos.users.create(newUser('keys@example.com'));

      const key = await repos.apiKeys.create({
        userId: user.id,
        name: 'Test key',
        keyHash: 'a'.repeat(64),
        keyPrefix: 'sk_abcd1234',
        scopes: ['sms:send'],
        expiresAt: null,
      });

      return { user, key };
    }

    it('round-trips by hash and by id', async () => {
      const { key } = await seedKey();

      expect(await repos.apiKeys.findByHash('a'.repeat(64))).toMatchObject({ id: key.id });
      expect(await repos.apiKeys.findById(key.id)).toMatchObject({ keyPrefix: 'sk_abcd1234' });
    });

    it('preserves the scopes array through the store', async () => {
      const user = await repos.users.create(newUser('scoped@example.com'));

      const key = await repos.apiKeys.create({
        userId: user.id,
        name: 'Gateway key',
        keyHash: 'b'.repeat(64),
        keyPrefix: 'sk_efgh5678',
        scopes: ['sms:send', 'gateway:connect'],
        expiresAt: null,
      });

      const found = await repos.apiKeys.findById(key.id);
      expect(found?.scopes).toEqual(['sms:send', 'gateway:connect']);
    });

    it('revoke() deactivates and stamps revokedAt', async () => {
      const { key } = await seedKey();

      await repos.apiKeys.revoke(key.id);

      const found = await repos.apiKeys.findById(key.id);
      expect(found?.isActive).toBe(false);
      expect(found?.revokedAt).not.toBeNull();
    });

    it('touchLastUsed() on a deleted key does not throw (it runs fire-and-forget)', async () => {
      await expect(
        repos.apiKeys.touchLastUsed('99999999-9999-4999-8999-999999999999', new Date()),
      ).resolves.not.toThrow();
    });

    it("lists only the owner's keys", async () => {
      const { user } = await seedKey();
      const other = await repos.users.create(newUser('other@example.com'));

      await repos.apiKeys.create({
        userId: other.id,
        name: 'Someone else',
        keyHash: 'c'.repeat(64),
        keyPrefix: 'sk_zzzz9999',
        scopes: ['sms:read'],
        expiresAt: null,
      });

      const mine = await repos.apiKeys.listForUser(user.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.name).toBe('Test key');
    });
  });

  // -------------------------------------------------------------------------
  describe('audit log', () => {
    it('appends and reads back newest-first', async () => {
      const user = await repos.users.create(newUser('audit@example.com'));

      await repos.auditLogs.create({
        userId: user.id,
        action: AuditAction.LOGIN_SUCCEEDED,
        status: 'SUCCESS',
        metadata: { email: 'audit@example.com' },
        ip: '10.0.0.1',
        userAgent: 'vitest',
        requestId: 'req-1',
      });
      await repos.auditLogs.create({
        userId: user.id,
        action: AuditAction.LOGIN_FAILED,
        status: 'FAILURE',
        metadata: { reason: 'bad_password' },
        ip: '10.0.0.1',
        userAgent: 'vitest',
        requestId: 'req-2',
      });

      const { items, total } = await repos.auditLogs.list({ page: 1, limit: 10 });

      expect(total).toBe(2);
      expect(items[0]?.action).toBe(AuditAction.LOGIN_FAILED); // newest first
      expect(items[0]?.metadata).toEqual({ reason: 'bad_password' });
    });

    it('supports an anonymous entry (a failed login against an unknown email)', async () => {
      const entry = await repos.auditLogs.create({
        userId: null,
        action: AuditAction.LOGIN_FAILED,
        status: 'FAILURE',
        metadata: { reason: 'unknown_email' },
        ip: null,
        userAgent: null,
        requestId: null,
      });

      expect(entry.userId).toBeNull();
    });

    it('filters by user, action and status', async () => {
      const user = await repos.users.create(newUser('filter@example.com'));

      await repos.auditLogs.create({
        userId: user.id,
        action: AuditAction.LOGIN_SUCCEEDED,
        status: 'SUCCESS',
        metadata: {},
        ip: null,
        userAgent: null,
        requestId: null,
      });
      await repos.auditLogs.create({
        userId: null,
        action: AuditAction.LOGIN_FAILED,
        status: 'FAILURE',
        metadata: {},
        ip: null,
        userAgent: null,
        requestId: null,
      });

      const failures = await repos.auditLogs.list({ page: 1, limit: 10, status: 'FAILURE' });
      expect(failures.total).toBe(1);
      expect(failures.items[0]?.action).toBe(AuditAction.LOGIN_FAILED);

      const mine = await repos.auditLogs.list({ page: 1, limit: 10, userId: user.id });
      expect(mine.total).toBe(1);
      expect(mine.items[0]?.status).toBe('SUCCESS');
    });
  });

  // -------------------------------------------------------------------------
  describe('gateways', () => {
    async function owner() {
      return repos.users.create(newUser('devices@example.com'));
    }

    it('registers a device and defaults it to OFFLINE', async () => {
      const user = await owner();

      const gateway = await repos.gateways.register({
        userId: user.id,
        deviceId: 'device-aaaa-1111',
        deviceName: 'Pixel 8',
        batteryLevel: 91,
      });

      // OFFLINE at registration, not ONLINE: the record exists, but nothing has
      // proven a socket is open. The WebSocket handler promotes it.
      expect(gateway).toMatchObject({
        deviceId: 'device-aaaa-1111',
        deviceName: 'Pixel 8',
        status: 'OFFLINE',
        batteryLevel: 91,
      });
      expect(gateway.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('UPSERTS on deviceId - a reconnect must not mint a second record', async () => {
      const user = await owner();

      const first = await repos.gateways.register({
        userId: user.id,
        deviceId: 'device-aaaa-1111',
        deviceName: 'Pixel 8',
      });

      const again = await repos.gateways.register({
        userId: user.id,
        deviceId: 'device-aaaa-1111',
        deviceName: 'Pixel 8 (renamed)',
      });

      expect(again.id).toBe(first.id);
      expect(again.deviceName).toBe('Pixel 8 (renamed)');
      // createdAt answers "when did we FIRST see this phone?" - a reconnect must
      // not reset it.
      expect(again.createdAt.getTime()).toBe(first.createdAt.getTime());

      expect(await repos.gateways.listForUser(user.id)).toHaveLength(1);
    });

    it('does not erase known telemetry when a heartbeat omits it', async () => {
      const user = await owner();

      const gateway = await repos.gateways.register({
        userId: user.id,
        deviceId: 'device-aaaa-1111',
        deviceName: 'Pixel 8',
        phoneNumber: '+919876543210',
        simOperator: 'Airtel',
      });

      // A heartbeat carrying only the battery level. The SIM details it does not
      // mention must survive - spreading undefined over them would wipe them.
      const updated = await repos.gateways.update(gateway.id, { batteryLevel: 40 });

      expect(updated).toMatchObject({
        batteryLevel: 40,
        phoneNumber: '+919876543210',
        simOperator: 'Airtel',
      });
    });

    it('reports absent telemetry as null, never undefined', async () => {
      const user = await owner();

      const gateway = await repos.gateways.register({
        userId: user.id,
        deviceId: 'device-bbbb-2222',
        deviceName: 'Bare',
      });

      // undefined would be dropped by JSON.stringify, so the dashboard would get
      // a response with the key missing entirely and no way to explain the gap.
      expect(gateway.batteryLevel).toBeNull();
      expect(gateway.phoneNumber).toBeNull();
      expect(gateway.canSendSms).toBeNull();
    });

    it('markAllOffline() clears the phantom-online state left by a crash', async () => {
      const user = await owner();

      const a = await repos.gateways.register({ userId: user.id, deviceId: 'dev-a-111111', deviceName: 'A' });
      const b = await repos.gateways.register({ userId: user.id, deviceId: 'dev-b-222222', deviceName: 'B' });

      await repos.gateways.update(a.id, { status: 'ONLINE' });
      await repos.gateways.update(b.id, { status: 'DEGRADED' });

      expect(await repos.gateways.markAllOffline()).toBe(2);
      expect((await repos.gateways.findById(a.id))?.status).toBe('OFFLINE');
      expect((await repos.gateways.findById(b.id))?.status).toBe('OFFLINE');

      // Idempotent: nothing left to demote.
      expect(await repos.gateways.markAllOffline()).toBe(0);
    });

    it('throws NotFound for a gateway that does not exist', async () => {
      await expect(repos.gateways.update('11111111-1111-4111-8111-111111111111', { status: 'ONLINE' })).rejects.toThrow(
        /not found/i,
      );
    });

    it('delete() removes the record and frees the deviceId for a fresh registration', async () => {
      const user = await owner();

      const gateway = await repos.gateways.register({
        userId: user.id,
        deviceId: 'device-cccc-3333',
        deviceName: 'To be removed',
      });

      await repos.gateways.delete(gateway.id);

      expect(await repos.gateways.findById(gateway.id)).toBeNull();
      expect(await repos.gateways.findByDeviceId('device-cccc-3333')).toBeNull();
      expect(await repos.gateways.listForUser(user.id)).toHaveLength(0);

      // The deviceId is free again: re-registering must mint a NEW record, not
      // resurrect the old one via a stale index entry.
      const fresh = await repos.gateways.register({
        userId: user.id,
        deviceId: 'device-cccc-3333',
        deviceName: 'Reinstalled',
      });
      expect(fresh.id).not.toBe(gateway.id);
    });

    it('delete() throws NotFound for a gateway that does not exist', async () => {
      await expect(repos.gateways.delete('11111111-1111-4111-8111-111111111111')).rejects.toThrow(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('messages', () => {
    async function sender() {
      return repos.users.create(newUser('sender@example.com'));
    }

    const newMessage = (userId: string, body = 'Hello') => ({
      userId,
      recipient: '+919876543210',
      body,
      partCount: 1,
      isUnicode: false,
      clientRef: null,
    });

    it('creates a message QUEUED, with the lifecycle timestamps unset', async () => {
      const user = await sender();

      const message = await repos.messages.create(newMessage(user.id));

      expect(message).toMatchObject({
        status: 'QUEUED',
        attempts: 0,
        gatewayId: null,
        sentAt: null,
        deliveredAt: null,
        failedAt: null,
      });
      expect(message.queuedAt).toBeInstanceOf(Date);
    });

    it('advances through the lifecycle without clobbering earlier timestamps', async () => {
      const user = await sender();
      const message = await repos.messages.create(newMessage(user.id));

      const dispatchedAt = new Date();
      await repos.messages.update(message.id, {
        status: 'SENDING',
        gatewayId: 'gw-1',
        dispatchedAt,
        attempts: 1,
      });

      const sent = await repos.messages.update(message.id, { status: 'SENT', sentAt: new Date() });

      // The whole reason these are separate columns: "it sat QUEUED for 40 minutes
      // then SENT in 200ms" must remain answerable after the fact.
      expect(sent.status).toBe('SENT');
      expect(sent.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(sent.queuedAt).toBeInstanceOf(Date);
      expect(sent.sentAt).toBeInstanceOf(Date);
      expect(sent.attempts).toBe(1);
    });

    describe('dailyLineStats()', () => {
      /** A message dispatched to a specific line at a specific moment, then settled. */
      async function dispatched(
        userId: string,
        line: { deviceId: string; subscriptionId: number; number: string },
        at: Date,
        status: 'SENT' | 'DELIVERED' | 'FAILED' | 'SENDING',
        partCount = 1,
      ) {
        const message = await repos.messages.create({ ...newMessage(userId), partCount });

        await repos.messages.update(message.id, {
          status,
          gatewayId: 'gw-1',
          senderNumber: line.number,
          senderDeviceId: line.deviceId,
          senderSubscriptionId: line.subscriptionId,
          dispatchedAt: at,
          attempts: 1,
        });

        return message;
      }

      const SIM_A = { deviceId: 'phone-1', subscriptionId: 1, number: '+919000000001' };
      const SIM_B = { deviceId: 'phone-1', subscriptionId: 2, number: '+919000000002' };

      const NOON = new Date('2026-07-22T12:00:00.000Z');
      const DAY_FROM = new Date('2026-07-22T00:00:00.000Z');
      const DAY_TO = new Date('2026-07-23T00:00:00.000Z');

      it('counts each line separately, by outcome', async () => {
        const user = await sender();

        await dispatched(user.id, SIM_A, NOON, 'SENT');
        await dispatched(user.id, SIM_A, NOON, 'DELIVERED');
        await dispatched(user.id, SIM_A, NOON, 'FAILED');
        await dispatched(user.id, SIM_B, NOON, 'SENT');

        const rows = await repos.messages.dailyLineStats(user.id, DAY_FROM, DAY_TO);
        const a = rows.find((r) => r.subscriptionId === 1);
        const b = rows.find((r) => r.subscriptionId === 2);

        // DELIVERED counts as sent: the radio accepted it, which is what the
        // operator means by "sent". `delivered` is the stronger subset.
        expect(a).toMatchObject({ deviceId: 'phone-1', attempted: 3, sent: 2, delivered: 1, failed: 1, parts: 3 });
        expect(b).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
      });

      it('counts PARTS, not messages - that is what the carrier caps', async () => {
        const user = await sender();

        await dispatched(user.id, SIM_A, NOON, 'SENT', 3);
        await dispatched(user.id, SIM_A, NOON, 'SENT', 2);

        const [row] = await repos.messages.dailyLineStats(user.id, DAY_FROM, DAY_TO);

        expect(row).toMatchObject({ attempted: 2, sent: 2, parts: 5 });
      });

      it('counts a message still in flight as pending, not as sent or failed', async () => {
        const user = await sender();

        await dispatched(user.id, SIM_A, NOON, 'SENDING');

        const [row] = await repos.messages.dailyLineStats(user.id, DAY_FROM, DAY_TO);

        expect(row).toMatchObject({ attempted: 1, sent: 0, failed: 0, pending: 1 });
      });

      it('excludes other days, other users, and messages that never reached a SIM', async () => {
        const user = await sender();
        const other = await repos.users.create(newUser('other@example.com'));

        await dispatched(user.id, SIM_A, NOON, 'SENT');
        await dispatched(user.id, SIM_A, new Date('2026-07-21T12:00:00.000Z'), 'SENT');
        await dispatched(other.id, SIM_A, NOON, 'SENT');
        // Accepted but never dispatched: it spent nobody's quota.
        await repos.messages.create(newMessage(user.id));

        const rows = await repos.messages.dailyLineStats(user.id, DAY_FROM, DAY_TO);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ attempted: 1 });
      });

      it('spans every account when asked for null - the cap belongs to the SIM, not the tenant', async () => {
        const user = await sender();
        const other = await repos.users.create(newUser('other@example.com'));

        await dispatched(user.id, SIM_A, NOON, 'SENT');
        await dispatched(other.id, SIM_A, NOON, 'SENT');

        const rows = await repos.messages.dailyLineStats(null, DAY_FROM, DAY_TO);

        expect(rows.reduce((n, r) => n + r.attempted, 0)).toBe(2);
      });
    });

    it('findQueuedForUser() returns OLDEST first - it is a queue, not a stack', async () => {
      const user = await sender();

      const first = await repos.messages.create(newMessage(user.id, 'first'));
      // Distinct timestamps: without a gap the sort is undefined and the test lies.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await repos.messages.create(newMessage(user.id, 'second'));

      const queued = await repos.messages.findQueuedForUser(user.id, 10);

      expect(queued.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it('findQueuedForUser() ignores messages that have already left the queue', async () => {
      const user = await sender();

      const queued = await repos.messages.create(newMessage(user.id, 'still waiting'));
      const gone = await repos.messages.create(newMessage(user.id, 'already out'));
      await repos.messages.update(gone.id, { status: 'SENT', sentAt: new Date() });

      const pending = await repos.messages.findQueuedForUser(user.id, 10);

      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(queued.id);
    });

    it('scopes the backlog to one user - a phone must never drain another tenant', async () => {
      const mine = await sender();
      const theirs = await repos.users.create(newUser('other-sender@example.com'));

      await repos.messages.create(newMessage(mine.id, 'mine'));
      await repos.messages.create(newMessage(theirs.id, 'theirs'));

      const drained = await repos.messages.findQueuedForUser(mine.id, 10);

      expect(drained).toHaveLength(1);
      expect(drained[0]?.body).toBe('mine');
    });

    it('lists newest-first and filters by status', async () => {
      const user = await sender();

      await repos.messages.create(newMessage(user.id, 'one'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const recent = await repos.messages.create(newMessage(user.id, 'two'));
      await repos.messages.update(recent.id, { status: 'FAILED', failedAt: new Date() });

      const all = await repos.messages.list({ page: 1, limit: 10, userId: user.id });
      expect(all.total).toBe(2);
      expect(all.items[0]?.body).toBe('two'); // newest first

      const failed = await repos.messages.list({ page: 1, limit: 10, userId: user.id, status: 'FAILED' });
      expect(failed.total).toBe(1);
      expect(failed.items[0]?.id).toBe(recent.id);
    });

    it('searches across recipient and body, case-insensitively and treating the term literally', async () => {
      const user = await sender();

      await repos.messages.create({
        userId: user.id,
        recipient: '+919876500001',
        body: 'Your OTP is 4821',
        partCount: 1,
        isUnicode: false,
        clientRef: null,
      });
      await repos.messages.create({
        userId: user.id,
        recipient: '+919000000002',
        body: 'Rent reminder for flat 3B',
        partCount: 1,
        isUnicode: false,
        clientRef: null,
      });

      // By recipient fragment.
      expect((await repos.messages.list({ page: 1, limit: 10, userId: user.id, search: '98765' })).total).toBe(1);
      // By body, different case.
      expect((await repos.messages.list({ page: 1, limit: 10, userId: user.id, search: 'otp' })).total).toBe(1);
      // A regex metacharacter must be matched literally, not interpreted - "." must
      // not become "any character" and match everything.
      expect((await repos.messages.list({ page: 1, limit: 10, userId: user.id, search: '.' })).total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('campaigns', () => {
    async function owner() {
      return repos.users.create(newUser('campaigner@example.com'));
    }

    const newCampaign = (
      userId: string,
      recipients: Array<{ to: string; name: string | null; vars: Record<string, string> }> = [
        { to: '+919876543210', name: 'Asha', vars: { name: 'Asha', amount: 'Rs 12,000' } },
        { to: '+919876543211', name: null, vars: {} },
      ],
    ) => ({
      userId,
      name: 'Diwali offer',
      body: 'Flat 20% off this week!',
      from: null,
      intervalMs: 10_000,
      windowStartHour: 9,
      windowEndHour: 18,
      partCount: 1,
      isUnicode: false,
      recipients,
    });

    it('creates a campaign DRAFT with one PENDING recipient per number', async () => {
      const user = await owner();

      const campaign = await repos.campaigns.create(newCampaign(user.id));

      expect(campaign.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(campaign.status).toBe('DRAFT');
      expect(campaign.sentCount).toBe(0);
      expect(campaign.failedCount).toBe(0);
      expect(campaign.lastSendAt).toBeNull();
      expect(campaign.startedAt).toBeNull();
      expect(campaign.recipients).toHaveLength(2);
      expect(campaign.recipients[0]).toMatchObject({
        to: '+919876543210',
        name: 'Asha',
        status: 'PENDING',
        messageId: null,
        error: null,
      });
      // A number that arrived without a name persists as null, not undefined.
      expect(campaign.recipients[1]?.name).toBeNull();
      // Template variables round-trip whole - they are what the body merges per row.
      expect(campaign.recipients[0]?.vars).toEqual({ name: 'Asha', amount: 'Rs 12,000' });
      expect(campaign.recipients[1]?.vars).toEqual({});
    });

    it('round-trips the embedded recipient list through the store', async () => {
      const user = await owner();
      const created = await repos.campaigns.create(newCampaign(user.id));

      const found = await repos.campaigns.findById(created.id);
      expect(found?.recipients.map((r) => r.to)).toEqual(['+919876543210', '+919876543211']);
    });

    it('applies a partial update (a recipient marked SENT) without clobbering the rest', async () => {
      const user = await owner();
      const campaign = await repos.campaigns.create(newCampaign(user.id));

      const recipients = campaign.recipients.map((r, i) =>
        i === 0 ? { ...r, status: 'SENT' as const, messageId: 'msg-1', sentAt: new Date() } : r,
      );

      const updated = await repos.campaigns.update(campaign.id, {
        recipients,
        sentCount: 1,
        lastSendAt: new Date(),
      });

      expect(updated.sentCount).toBe(1);
      expect(updated.name).toBe('Diwali offer'); // untouched
      expect(updated.recipients[0]).toMatchObject({ status: 'SENT', messageId: 'msg-1' });
      expect(updated.recipients[1]?.status).toBe('PENDING');
      expect(updated.lastSendAt).toBeInstanceOf(Date);
    });

    it('listByStatus returns campaigns across all users in the requested state only', async () => {
      const a = await owner();
      const b = await repos.users.create(newUser('other-campaigner@example.com'));

      const running = await repos.campaigns.create(newCampaign(a.id));
      await repos.campaigns.update(running.id, { status: 'RUNNING' });
      await repos.campaigns.create(newCampaign(b.id)); // stays DRAFT

      const runningOnes = await repos.campaigns.listByStatus('RUNNING');
      expect(runningOnes).toHaveLength(1);
      expect(runningOnes[0]?.id).toBe(running.id);
    });

    it('scopes the list to one owner and paginates newest-first', async () => {
      const user = await owner();
      const other = await repos.users.create(newUser('nosy@example.com'));

      await repos.campaigns.create(newCampaign(user.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newest = await repos.campaigns.create({ ...newCampaign(user.id), name: 'Newer' });
      await repos.campaigns.create(newCampaign(other.id));

      const mine = await repos.campaigns.list({ page: 1, limit: 10, userId: user.id });
      expect(mine.total).toBe(2);
      expect(mine.items[0]?.id).toBe(newest.id); // newest first
    });

    it('throws NotFound when updating a campaign that does not exist', async () => {
      await expect(
        repos.campaigns.update('11111111-1111-4111-8111-111111111111', { status: 'CANCELLED' }),
      ).rejects.toThrow(/not found/i);
    });
  });
});
