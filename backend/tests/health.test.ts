import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { healthRegistry } from '../src/modules/health/health.registry.js';

/**
 * Health endpoint contract.
 *
 * These assertions are load-bearing for operations: Docker's healthcheck and any
 * future orchestrator key off the exact status codes below. Changing 503 to 500
 * on readiness failure would silently break rolling deploys, so we pin it.
 */
describe('health endpoints', () => {
  let app: Express;

  beforeEach(() => {
    healthRegistry.reset();
    app = createApp();
  });

  afterEach(() => {
    healthRegistry.reset();
  });

  describe('GET /health', () => {
    it('reports liveness without touching any dependency', async () => {
      // A registered-and-failing dependency must NOT affect liveness: the process
      // is alive, and restarting it would not fix a broken database.
      healthRegistry.register('mongo', () => {
        throw new Error('connection refused');
      });

      const response = await request(app).get('/health').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { status: 'ok' },
      });
      expect(response.body.data.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('is reachable at the API prefix as well as the root', async () => {
      await request(app).get('/api/health').expect(200);
    });

    it('echoes a correlation id on every response', async () => {
      const response = await request(app).get('/health').expect(200);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('reuses an upstream X-Request-Id so a trace spans services', async () => {
      const response = await request(app)
        .get('/health')
        .set('X-Request-Id', 'trace-abc-12345678')
        .expect(200);

      expect(response.headers['x-request-id']).toBe('trace-abc-12345678');
    });
  });

  describe('GET /health/ready', () => {
    it('is ready when no dependencies are registered', async () => {
      const response = await request(app).get('/health/ready').expect(200);

      expect(response.body.data).toMatchObject({ status: 'ready', ready: true });
      expect(response.body.data.checks).toEqual({});
    });

    it('is ready when every registered check passes', async () => {
      healthRegistry.register('mongo', () => ({ status: 'up', details: { pool: 5 } }));
      healthRegistry.register('redis', async () => {
        await Promise.resolve();
      });

      const response = await request(app).get('/health/ready').expect(200);

      expect(response.body.data.ready).toBe(true);
      expect(response.body.data.checks.mongo).toMatchObject({ status: 'up', details: { pool: 5 } });
      expect(response.body.data.checks.redis.status).toBe('up');
    });

    it('returns 503 when a critical dependency is down', async () => {
      healthRegistry.register('mongo', () => {
        throw new Error('ECONNREFUSED 127.0.0.1:27017');
      });

      const response = await request(app).get('/health/ready').expect(503);

      expect(response.body.data).toMatchObject({ status: 'not_ready', ready: false });
      expect(response.body.data.checks.mongo).toMatchObject({
        status: 'down',
        error: 'ECONNREFUSED 127.0.0.1:27017',
        critical: true,
      });
    });

    it('stays ready when a NON-critical dependency is down', async () => {
      healthRegistry.register('metrics-sink', () => {
        throw new Error('sink unreachable');
      }, { critical: false });

      const response = await request(app).get('/health/ready').expect(200);

      expect(response.body.data.ready).toBe(true);
      expect(response.body.data.checks['metrics-sink'].status).toBe('down');
    });

    it('does not hang forever on a wedged dependency', async () => {
      healthRegistry.register('slow-db', () => new Promise(() => {/* never settles */}), { timeoutMs: 50 });

      const response = await request(app).get('/health/ready').expect(503);

      expect(response.body.data.checks['slow-db']).toMatchObject({ status: 'down' });
      expect(response.body.data.checks['slow-db'].error).toContain('timed out');
    });
  });

  describe('GET /health/info', () => {
    it('reports build and runtime identity', async () => {
      const response = await request(app).get('/health/info').expect(200);

      expect(response.body.data).toMatchObject({
        environment: 'test',
        timezone: 'Asia/Kolkata',
        pid: process.pid,
      });
      expect(response.body.data.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(response.body.data.memory.rssMb).toBeGreaterThan(0);
    });
  });
});
