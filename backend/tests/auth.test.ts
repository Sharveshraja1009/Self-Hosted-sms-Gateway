import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { AuditAction } from '../src/domain/audit.js';
import { ApiKeyScope, Role } from '../src/domain/user.js';
import { ErrorCode } from '../src/core/errors.js';
import { repositories, resetRepositories } from '../src/repositories/index.js';

/**
 * Auth contract + security properties.
 *
 * The interesting tests here are not the happy paths - they are the ones that
 * pin down behaviour an attacker cares about: enumeration, token reuse,
 * privilege escalation, credential lifetime. Each one exists because getting it
 * wrong is a breach, not a bug report.
 */

const REGISTER = '/api/auth/register';
const LOGIN = '/api/auth/login';
const REFRESH = '/api/auth/refresh';

interface Creds {
  email: string;
  password: string;
  name: string;
}

const alice: Creds = { email: 'alice@example.com', password: 'correct-horse-battery', name: 'Alice' };
const bob: Creds = { email: 'bob@example.com', password: 'another-good-passphrase', name: 'Bob' };

describe('auth', () => {
  let app: Express;

  beforeEach(() => {
    // Every test gets a virgin store. No shared state, no ordering dependencies.
    resetRepositories();
    app = createApp();
  });

  async function register(creds: Creds = alice) {
    const response = await request(app).post(REGISTER).send(creds).expect(201);
    return response.body.data as {
      user: { id: string; email: string; role: string };
      tokens: { accessToken: string; refreshToken: string; expiresIn: number };
    };
  }

  // -------------------------------------------------------------------------
  describe('POST /api/auth/register', () => {
    it('creates an account and returns a token pair', async () => {
      const response = await request(app).post(REGISTER).send(alice).expect(201);

      expect(response.body.data.user).toMatchObject({ email: alice.email, name: 'Alice', isActive: true });
      expect(response.body.data.tokens).toMatchObject({ tokenType: 'Bearer' });
      expect(response.body.data.tokens.accessToken).toMatch(/^eyJ/); // a JWT
      expect(response.body.data.tokens.refreshToken).toBeTypeOf('string');
    });

    it('NEVER returns the password hash', async () => {
      const response = await request(app).post(REGISTER).send(alice).expect(201);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('$2'); // a bcrypt digest starts $2a/$2b
      expect(serialised).not.toContain(alice.password);
    });

    it('makes the FIRST user an admin and everyone after that a plain user', async () => {
      const first = await register(alice);
      expect(first.user.role).toBe(Role.ADMIN);

      const second = await request(app).post(REGISTER).send(bob).expect(201);
      expect(second.body.data.user.role).toBe(Role.USER);
    });

    it('treats email as case- and whitespace-insensitive', async () => {
      await register(alice);

      const response = await request(app)
        .post(REGISTER)
        .send({ ...alice, email: '  ALICE@Example.COM  ' })
        .expect(409);

      expect(response.body.error.code).toBe(ErrorCode.ALREADY_EXISTS);
    });

    it('rejects a password below the policy floor', async () => {
      const response = await request(app)
        .post(REGISTER)
        .send({ ...alice, password: 'short' })
        .expect(422);

      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'password' })]),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('POST /api/auth/login', () => {
    it('returns a fresh token pair for correct credentials', async () => {
      await register(alice);

      const response = await request(app)
        .post(LOGIN)
        .send({ email: alice.email, password: alice.password })
        .expect(200);

      expect(response.body.data.user.email).toBe(alice.email);
      expect(response.body.data.tokens.accessToken).toMatch(/^eyJ/);
    });

    it('gives an IDENTICAL response for a wrong password and an unknown email', async () => {
      await register(alice);

      const wrongPassword = await request(app)
        .post(LOGIN)
        .send({ email: alice.email, password: 'not-the-right-password' })
        .expect(401);

      const unknownEmail = await request(app)
        .post(LOGIN)
        .send({ email: 'nobody@example.com', password: 'not-the-right-password' })
        .expect(401);

      // Same code, same message: the API is not an oracle for "does this account exist?"
      expect(wrongPassword.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(unknownEmail.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });

    it('refuses a disabled account', async () => {
      const { user } = await register(alice);
      await repositories().users.update(user.id, { isActive: false });

      const response = await request(app)
        .post(LOGIN)
        .send({ email: alice.email, password: alice.password })
        .expect(401);

      expect(response.body.error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    });

    it('records both successful and failed attempts in the audit trail', async () => {
      await register(alice);
      await request(app).post(LOGIN).send({ email: alice.email, password: alice.password }).expect(200);
      await request(app).post(LOGIN).send({ email: alice.email, password: 'wrong' }).expect(401);

      const { items } = await repositories().auditLogs.list({ page: 1, limit: 50 });
      const actions = items.map((entry) => `${entry.action}:${entry.status}`);

      expect(actions).toContain(`${AuditAction.LOGIN_SUCCEEDED}:SUCCESS`);
      expect(actions).toContain(`${AuditAction.LOGIN_FAILED}:FAILURE`);

      // The audit trail must never become a place secrets go to hide.
      expect(JSON.stringify(items)).not.toContain(alice.password);
    });
  });

  // -------------------------------------------------------------------------
  describe('GET /api/auth/me', () => {
    it('resolves the caller from a Bearer access token', async () => {
      const { tokens } = await register(alice);

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect(response.body.data.email).toBe(alice.email);
    });

    it('rejects a missing credential', async () => {
      const response = await request(app).get('/api/auth/me').expect(401);
      expect(response.body.error.code).toBe(ErrorCode.UNAUTHORIZED);
    });

    it('rejects a forged token', async () => {
      const { tokens } = await register(alice);
      // Flip the last character of the signature.
      const forged = tokens.accessToken.slice(0, -1) + (tokens.accessToken.endsWith('A') ? 'B' : 'A');

      const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);

      expect(response.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('rejects an unsigned "alg: none" token', async () => {
      // The classic JWT attack: strip the signature, claim admin.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'attacker', email: 'x@y.z', role: 'ADMIN', typ: 'access' }),
      ).toString('base64url');

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${header}.${payload}.`)
        .expect(401);

      expect(response.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
    });
  });

  // -------------------------------------------------------------------------
  describe('POST /api/auth/refresh', () => {
    it('rotates the refresh token and issues a new access token', async () => {
      const { tokens } = await register(alice);

      const response = await request(app).post(REFRESH).send({ refreshToken: tokens.refreshToken }).expect(200);

      // The returned refresh token must be NEW - a static refresh token is a
      // 30-day bearer credential with no revocation story.
      expect(response.body.data.tokens.refreshToken).not.toBe(tokens.refreshToken);
      expect(response.body.data.tokens.accessToken).toMatch(/^eyJ/);
    });

    it('DETECTS REUSE: replaying a spent token revokes the whole family', async () => {
      const { tokens } = await register(alice);

      // Legitimate rotation.
      const rotated = await request(app).post(REFRESH).send({ refreshToken: tokens.refreshToken }).expect(200);
      const newRefresh = rotated.body.data.tokens.refreshToken as string;

      // An attacker replays the token they captured earlier.
      const replay = await request(app).post(REFRESH).send({ refreshToken: tokens.refreshToken }).expect(401);
      expect(replay.body.error.code).toBe(ErrorCode.TOKEN_INVALID);

      // ...and the victim's *current, legitimate* token is now dead too. This is
      // the point: we cannot tell attacker from victim, so both are logged out
      // and the human must re-authenticate. Better a forced login than a silent
      // 30-day compromise.
      const victim = await request(app).post(REFRESH).send({ refreshToken: newRefresh }).expect(401);
      expect(victim.body.error.code).toBe(ErrorCode.TOKEN_INVALID);

      const { items } = await repositories().auditLogs.list({ page: 1, limit: 50 });
      expect(items.map((e) => e.action)).toContain(AuditAction.TOKEN_REUSE_DETECTED);
    });

    it('rejects an unknown token', async () => {
      await register(alice);
      const response = await request(app).post(REFRESH).send({ refreshToken: 'not-a-real-token' }).expect(401);
      expect(response.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('stops working once the account is disabled', async () => {
      const { user, tokens } = await register(alice);
      await repositories().users.update(user.id, { isActive: false });

      const response = await request(app).post(REFRESH).send({ refreshToken: tokens.refreshToken }).expect(401);
      expect(response.body.error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    });
  });

  // -------------------------------------------------------------------------
  describe('logout', () => {
    it('kills the session it was given', async () => {
      const { tokens } = await register(alice);

      await request(app).post('/api/auth/logout').send({ refreshToken: tokens.refreshToken }).expect(200);

      // A revoked token presented again is treated as reuse - still a 401.
      await request(app).post(REFRESH).send({ refreshToken: tokens.refreshToken }).expect(401);
    });

    it('is idempotent for an unknown token (no probing oracle)', async () => {
      await request(app).post('/api/auth/logout').send({ refreshToken: 'never-existed' }).expect(200);
    });

    it('logout-all revokes every session', async () => {
      await register(alice);

      const session1 = await request(app).post(LOGIN).send({ email: alice.email, password: alice.password });
      const session2 = await request(app).post(LOGIN).send({ email: alice.email, password: alice.password });

      const response = await request(app)
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${session1.body.data.tokens.accessToken}`)
        .expect(200);

      expect(response.body.data.sessionsRevoked).toBeGreaterThanOrEqual(2);

      // Neither device can refresh any more.
      await request(app).post(REFRESH).send({ refreshToken: session1.body.data.tokens.refreshToken }).expect(401);
      await request(app).post(REFRESH).send({ refreshToken: session2.body.data.tokens.refreshToken }).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('POST /api/auth/change-password', () => {
    it('requires the current password even when already authenticated', async () => {
      const { tokens } = await register(alice);

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPassword: 'wrong-current', newPassword: 'a-brand-new-passphrase' })
        .expect(401);

      expect(response.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    });

    it('changes the password and signs every session out', async () => {
      const { tokens } = await register(alice);

      await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPassword: alice.password, newPassword: 'a-brand-new-passphrase' })
        .expect(200);

      // Old refresh token is dead.
      await request(app).post(REFRESH).send({ refreshToken: tokens.refreshToken }).expect(401);

      // Old password no longer works; new one does.
      await request(app).post(LOGIN).send({ email: alice.email, password: alice.password }).expect(401);
      await request(app).post(LOGIN).send({ email: alice.email, password: 'a-brand-new-passphrase' }).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('API keys', () => {
    async function createKey(accessToken: string, scopes: ApiKeyScope[] = [ApiKeyScope.SMS_SEND]) {
      const response = await request(app)
        .post('/api/auth/api-keys')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'CI pipeline', scopes })
        .expect(201);

      return response.body.data as { id: string; plaintext: string; keyPrefix: string; scopes: ApiKeyScope[] };
    }

    it('returns the plaintext exactly once, at creation', async () => {
      const { tokens } = await register(alice);
      const created = await createKey(tokens.accessToken);

      expect(created.plaintext).toMatch(/^sk_[A-Za-z0-9_-]{40,}$/);
      expect(created.keyPrefix).toBe(created.plaintext.slice(0, 11));

      // Listing keys must never surface it again.
      const list = await request(app)
        .get('/api/auth/api-keys')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect(JSON.stringify(list.body)).not.toContain(created.plaintext);
      expect(list.body.data[0]).toMatchObject({ name: 'CI pipeline', keyPrefix: created.keyPrefix });
    });

    it('stores only a hash - the plaintext is not recoverable from the store', async () => {
      const { tokens } = await register(alice);
      const created = await createKey(tokens.accessToken);

      const stored = await repositories().apiKeys.findById(created.id);
      expect(stored?.keyHash).not.toBe(created.plaintext);
      expect(stored?.keyHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256, hex
    });

    it('authenticates a request via the X-Api-Key header', async () => {
      const { tokens } = await register(alice);
      const created = await createKey(tokens.accessToken);

      const response = await request(app).get('/api/auth/me').set('X-Api-Key', created.plaintext).expect(200);

      expect(response.body.data.email).toBe(alice.email);
    });

    it('also accepts the key as a Bearer credential (integrators do this constantly)', async () => {
      const { tokens } = await register(alice);
      const created = await createKey(tokens.accessToken);

      await request(app).get('/api/auth/me').set('Authorization', `Bearer ${created.plaintext}`).expect(200);
    });

    it('stops working the moment it is revoked', async () => {
      const { tokens } = await register(alice);
      const created = await createKey(tokens.accessToken);

      await request(app).get('/api/auth/me').set('X-Api-Key', created.plaintext).expect(200);

      await request(app)
        .delete(`/api/auth/api-keys/${created.id}`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      const response = await request(app).get('/api/auth/me').set('X-Api-Key', created.plaintext).expect(401);
      expect(response.body.error.code).toBe(ErrorCode.API_KEY_INVALID);
    });

    it('dies with its owner: disabling the account disables the key', async () => {
      const { user, tokens } = await register(alice);
      const created = await createKey(tokens.accessToken);

      await repositories().users.update(user.id, { isActive: false });

      const response = await request(app).get('/api/auth/me').set('X-Api-Key', created.plaintext).expect(401);
      expect(response.body.error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    });

    it('cannot be revoked by a different user', async () => {
      const aliceAuth = await register(alice);
      const created = await createKey(aliceAuth.tokens.accessToken);

      const bobAuth = await request(app).post(REGISTER).send(bob).expect(201);

      const response = await request(app)
        .delete(`/api/auth/api-keys/${created.id}`)
        .set('Authorization', `Bearer ${bobAuth.body.data.tokens.accessToken}`)
        .expect(403);

      expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);

      // Alice's key still works.
      await request(app).get('/api/auth/me').set('X-Api-Key', created.plaintext).expect(200);
    });

    it('rejects a key that never existed', async () => {
      const response = await request(app).get('/api/auth/me').set('X-Api-Key', 'sk_totally-made-up').expect(401);
      expect(response.body.error.code).toBe(ErrorCode.API_KEY_INVALID);
    });

    it('defaults to the least useful privilege (sms:send only)', async () => {
      const { tokens } = await register(alice);

      const response = await request(app)
        .post('/api/auth/api-keys')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ name: 'no scopes given' })
        .expect(201);

      expect(response.body.data.scopes).toEqual([ApiKeyScope.SMS_SEND]);
    });
  });
});
