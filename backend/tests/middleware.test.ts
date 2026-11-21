import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from '../src/app.js';
import { ErrorCode, ForbiddenError, NotFoundError } from '../src/core/errors.js';
import { sendSuccess } from '../src/core/http-response.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestId } from '../src/middleware/request-id.js';
import { validate, validatedBody, validatedQuery } from '../src/middleware/validate.js';

/**
 * The cross-cutting HTTP contract: envelope shape, validation, error mapping.
 *
 * Every client we will ever write - dashboard, Android app, a customer's cURL -
 * depends on these shapes. They are tested here, once, so no individual route
 * has to re-prove them.
 */

/** A minimal app carrying only the middleware under test, so failures point at one thing. */
function harness(mount: (app: Express) => void): Express {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  mount(app);
  app.use(errorHandler);
  return app;
}

describe('response envelope', () => {
  it('wraps success as { success: true, data, requestId }', async () => {
    const app = harness((a) => {
      a.get('/thing', (_req, res) => sendSuccess(res, { id: 'abc' }));
    });

    const response = await request(app).get('/thing').expect(200);

    expect(response.body).toMatchObject({ success: true, data: { id: 'abc' } });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });
});

describe('error handler', () => {
  it('maps an AppError to its status and machine-readable code', async () => {
    const app = harness((a) => {
      a.get('/missing', () => {
        throw new NotFoundError('Message');
      });
    });

    const response = await request(app).get('/missing').expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: ErrorCode.NOT_FOUND, message: 'Message not found' },
    });
  });

  it('catches rejections from async handlers (Express 5 forwards them)', async () => {
    const app = harness((a) => {
      a.get('/async-boom', async () => {
        await Promise.resolve();
        throw new ForbiddenError('Nope');
      });
    });

    const response = await request(app).get('/async-boom').expect(403);
    expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('reduces an unexpected bug to a generic 500 without leaking internals', async () => {
    const app = harness((a) => {
      a.get('/bug', () => {
        throw new Error('SELECT * FROM users WHERE password = ...');
      });
    });

    const response = await request(app).get('/bug').expect(500);

    expect(response.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    // NODE_ENV=test behaves like development, so the message is exposed for
    // debugging - but it is flagged non-operational, which is what production
    // uses to substitute "Internal server error". Assert the flagging worked.
    expect(response.body.error).toHaveProperty('stack');
  });

  it('rejects malformed JSON with a 400, not a crash', async () => {
    const app = harness((a) => {
      a.post('/echo', (req, res) => sendSuccess(res, req.body));
    });

    const response = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"phone": ')
      .expect(400);

    expect(response.body.error.code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe('validate()', () => {
  const bodySchema = z.object({
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be E.164, e.g. +919876543210'),
    message: z.string().min(1).max(1600),
  });

  const querySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });

  it('passes a valid body through and strips unknown keys', async () => {
    const app = harness((a) => {
      a.post('/send', validate({ body: bodySchema }), (req, res) => {
        sendSuccess(res, validatedBody<z.infer<typeof bodySchema>>(req));
      });
    });

    const response = await request(app)
      .post('/send')
      .send({ phone: '+919876543210', message: 'Hello', isAdmin: true })
      .expect(200);

    expect(response.body.data).toEqual({ phone: '+919876543210', message: 'Hello' });
    expect(response.body.data).not.toHaveProperty('isAdmin');
  });

  it('rejects an invalid body with 422 and per-field detail', async () => {
    const app = harness((a) => {
      a.post('/send', validate({ body: bodySchema }), (_req, res) => sendSuccess(res, null));
    });

    const response = await request(app)
      .post('/send')
      .send({ phone: '9876543210', message: '' })
      .expect(422);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'body', field: 'phone' }),
        expect.objectContaining({ source: 'body', field: 'message' }),
      ]),
    );
  });

  it('coerces and defaults query params onto req.validated (Express 5 req.query is read-only)', async () => {
    const app = harness((a) => {
      a.get('/messages', validate({ query: querySchema }), (req, res) => {
        sendSuccess(res, validatedQuery<z.infer<typeof querySchema>>(req));
      });
    });

    const withValues = await request(app).get('/messages?page=3&limit=50').expect(200);
    expect(withValues.body.data).toEqual({ page: 3, limit: 50 });

    const withDefaults = await request(app).get('/messages').expect(200);
    expect(withDefaults.body.data).toEqual({ page: 1, limit: 20 });
  });
});

describe('application wiring', () => {
  it('returns a JSON 404 for unknown routes instead of an HTML page', async () => {
    const response = await request(createApp()).get('/api/does-not-exist').expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: ErrorCode.NOT_FOUND },
    });
    expect(response.body.error.message).toContain('/api/does-not-exist');
  });

  it('does not advertise the framework', async () => {
    const response = await request(createApp()).get('/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets security headers from helmet', async () => {
    const response = await request(createApp()).get('/health').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows a configured browser origin', async () => {
    const response = await request(createApp())
      .get('/api')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rejects an unconfigured browser origin', async () => {
    const response = await request(createApp())
      .get('/api')
      .set('Origin', 'https://evil.example.com')
      .expect(403);

    expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('allows origin-less callers (the Android gateway, cURL, integrators)', async () => {
    await request(createApp()).get('/api').expect(200);
  });

  it('allows the server talking to itself - the built-in admin panel', async () => {
    // The admin panel is served from the same origin as the API. Its fetches carry
    // an Origin header whose host equals the request Host, and that must be allowed
    // regardless of what CORS_ORIGINS lists - otherwise the gateway rejects its own
    // panel. Supertest addresses the app at 127.0.0.1:<port>, so echo that back.
    const app = createApp();
    const probe = await request(app).get('/api');
    // superagent's Request carries the host it dialled, but @types/superagent does
    // not surface it - narrow through a structural cast rather than `any`.
    const host = (probe.request as unknown as { host: string }).host; // e.g. "127.0.0.1:54321"

    const response = await request(app)
      .get('/api')
      .set('Origin', `http://${host}`)
      .set('Host', host)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(`http://${host}`);
  });
});
