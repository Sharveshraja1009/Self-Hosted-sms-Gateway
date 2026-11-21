import http from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createApp } from '../src/app.js';
import { GatewayStatus } from '../src/domain/gateway.js';
import { MessageStatus } from '../src/domain/message.js';
import { ApiKeyScope } from '../src/domain/user.js';
import { attachGatewayWebSocket, GATEWAY_WS_PATH } from '../src/modules/gateway/gateway.socket.js';
import { gatewayRegistry } from '../src/modules/gateway/gateway.registry.js';
import { consume, resetQuotas } from '../src/modules/sms/sim-quota.js';
import { repositories, resetRepositories } from '../src/repositories/index.js';

/**
 * The end-to-end gateway path, over a REAL WebSocket.
 *
 * This is the test that matters, because it is the only one that exercises the
 * thing the product actually is: a message accepted over HTTP appears on a phone's
 * socket, and the phone's report comes back and moves the message. Everything else
 * in this repo is scaffolding around that round trip.
 *
 * It opens a real listener on an ephemeral port and speaks the real wire protocol.
 * A mocked socket here would prove nothing - the bugs in this layer live in the
 * upgrade handshake and the frame plumbing, which a mock replaces with wishful
 * thinking.
 */

const DEVICE_ID = 'test-device-0000000001';

describe('gateway end-to-end', () => {
  let server: http.Server;
  let baseUrl: string;
  let wsUrl: string;

  /** A registered user plus an API key carrying whichever scopes the test needs. */
  async function seedUser(scopes: ApiKeyScope[]) {
    const app = createApp();

    const registration = await request(server)
      .post('/api/auth/register')
      .send({ email: 'gw@example.com', password: 'correct-horse-battery', name: 'GW' })
      .expect(201);

    const accessToken = registration.body.data.tokens.accessToken as string;

    const key = await request(server)
      .post('/api/auth/api-keys')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'device', scopes })
      .expect(201);

    void app;

    return {
      userId: registration.body.data.user.id as string,
      accessToken,
      apiKey: key.body.data.plaintext as string,
    };
  }

  /** Opens a socket, waits for it to be usable, and buffers every frame it receives. */
  function connect(apiKey: string): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${wsUrl}${GATEWAY_WS_PATH}`, {
        headers: { 'x-api-key': apiKey },
      });

      const frames: Record<string, unknown>[] = [];

      socket.on('message', (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
      });
      socket.on('open', () => resolve({ socket, frames }));
      socket.on('error', reject);
    });
  }

  /** Polls the buffer for a frame of a given type. The protocol is async; the test must be too. */
  async function waitForFrame(
    frames: Record<string, unknown>[],
    type: string,
    timeoutMs = 2_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const frame = frames.find((f) => f.type === type);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for a "${type}" frame. Got: ${JSON.stringify(frames)}`);
  }

  /** Waits for an `sms.send` dispatched to a SPECIFIC subscriptionId - needed to see a failover land on the other SIM. */
  async function waitForSendTo(
    frames: Record<string, unknown>[],
    subscriptionId: number,
    timeoutMs = 2_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = frames.find((f) => f.type === 'sms.send' && f.subscriptionId === subscriptionId);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for sms.send to SIM ${subscriptionId}. Got: ${JSON.stringify(frames)}`);
  }

  /** Polls a message until it reaches an expected status. */
  async function waitForStatus(messageId: string, status: MessageStatus, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const message = await repositories().messages.findById(messageId);
      if (message?.status === status) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const actual = await repositories().messages.findById(messageId);
    throw new Error(`Timed out waiting for ${status}; message is ${actual?.status}`);
  }

  /** A user, an API key with every scope, and a phone already registered on the socket. */
  async function connectedDevice() {
    const user = await seedUser([ApiKeyScope.GATEWAY_CONNECT, ApiKeyScope.SMS_SEND, ApiKeyScope.SMS_READ]);

    const { socket, frames } = await connect(user.apiKey);
    socket.send(
      JSON.stringify({
        type: 'register',
        deviceId: DEVICE_ID,
        deviceName: 'Phone',
        canSendSms: true,
        // The SIM's own number. In the field this is usually typed in by the
        // operator, because Android generally cannot report it.
        phoneNumber: '+919000000001',
      }),
    );
    await waitForFrame(frames, 'registered');

    return { ...user, socket, frames };
  }

  beforeEach(async () => {
    resetRepositories();
    gatewayRegistry.clear();
    // The per-SIM quota is process-global and would otherwise carry counts from
    // one test into the next, eventually tripping the daily cap mid-suite.
    resetQuotas();

    server = http.createServer(createApp());
    attachGatewayWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}`;
    void baseUrl;
  });

  afterEach(async () => {
    for (const connection of gatewayRegistry.all()) {
      connection.socket.terminate();
    }
    gatewayRegistry.clear();

    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  // -------------------------------------------------------------------------
  describe('the upgrade handshake', () => {
    it('refuses a socket with no API key', async () => {
      await expect(
        new Promise((resolve, reject) => {
          const socket = new WebSocket(`${wsUrl}${GATEWAY_WS_PATH}`);
          socket.on('open', () => resolve('opened'));
          socket.on('error', reject);
        }),
      ).rejects.toThrow(/401/);
    });

    it('refuses a key that lacks the gateway:connect scope', async () => {
      // A key minted for a customer's server must not be usable to impersonate a
      // handset and start receiving that account's messages.
      const { apiKey } = await seedUser([ApiKeyScope.SMS_SEND]);

      await expect(connect(apiKey)).rejects.toThrow(/403/);
    });

    it('accepts a key carrying gateway:connect', async () => {
      const { apiKey } = await seedUser([ApiKeyScope.GATEWAY_CONNECT]);

      const { socket } = await connect(apiKey);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    });
  });

  // -------------------------------------------------------------------------
  describe('registration', () => {
    it('creates a gateway record and acknowledges', async () => {
      const { apiKey } = await seedUser([ApiKeyScope.GATEWAY_CONNECT]);
      const { socket, frames } = await connect(apiKey);

      socket.send(
        JSON.stringify({
          type: 'register',
          deviceId: DEVICE_ID,
          deviceName: 'Pixel Test',
          batteryLevel: 82,
          isCharging: true,
          canSendSms: true,
          simOperator: 'Airtel',
        }),
      );

      const registered = await waitForFrame(frames, 'registered');
      expect(registered.gatewayId).toEqual(expect.any(String));
      expect(registered.heartbeatIntervalMs).toBeGreaterThan(0);

      const gateway = await repositories().gateways.findByDeviceId(DEVICE_ID);
      expect(gateway).toMatchObject({
        deviceName: 'Pixel Test',
        status: GatewayStatus.ONLINE,
        batteryLevel: 82,
        simOperator: 'Airtel',
      });

      socket.close();
    });

    it('does NOT duplicate the gateway when the same device reconnects', async () => {
      const { apiKey } = await seedUser([ApiKeyScope.GATEWAY_CONNECT]);

      const first = await connect(apiKey);
      first.socket.send(JSON.stringify({ type: 'register', deviceId: DEVICE_ID, deviceName: 'Phone' }));
      const firstAck = await waitForFrame(first.frames, 'registered');
      first.socket.close();

      const second = await connect(apiKey);
      second.socket.send(JSON.stringify({ type: 'register', deviceId: DEVICE_ID, deviceName: 'Phone' }));
      const secondAck = await waitForFrame(second.frames, 'registered');

      // Same handset, same record. A phone on flaky data reconnects dozens of
      // times a day; each one must not mint a new gateway.
      expect(secondAck.gatewayId).toBe(firstAck.gatewayId);

      second.socket.close();
    });

    it('marks a device with no SMS permission DEGRADED, not ONLINE', async () => {
      const { apiKey } = await seedUser([ApiKeyScope.GATEWAY_CONNECT]);
      const { socket, frames } = await connect(apiKey);

      socket.send(JSON.stringify({ type: 'register', deviceId: DEVICE_ID, deviceName: 'Phone', canSendSms: false }));
      await waitForFrame(frames, 'registered');

      const gateway = await repositories().gateways.findByDeviceId(DEVICE_ID);
      expect(gateway?.status).toBe(GatewayStatus.DEGRADED);

      socket.close();
    });
  });

  // -------------------------------------------------------------------------
  describe('the send round trip', () => {
    it('delivers an accepted message to the phone and settles it as SENT then DELIVERED', async () => {
      const device = await connectedDevice();

      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Hello from the gateway' })
        .expect(202);

      const messageId = accepted.body.data.id as string;
      expect(accepted.body.data.status).toBe(MessageStatus.SENDING);
      expect(accepted.body.meta.dispatched).toBe(true);

      // The phone receives the dispatch, and is told which SIM it is sending from
      // so its own history can render "from -> to" without re-deriving anything.
      const dispatch = await waitForFrame(device.frames, 'sms.send');
      expect(dispatch).toMatchObject({
        messageId,
        recipient: '+919876543210',
        body: 'Hello from the gateway',
        senderNumber: '+919000000001',
      });

      // The radio accepted it.
      device.socket.send(JSON.stringify({ type: 'sms.result', messageId, status: 'SENT' }));
      await waitForStatus(messageId, MessageStatus.SENT);

      // ...and later, the carrier confirms arrival.
      device.socket.send(JSON.stringify({ type: 'sms.delivered', messageId }));
      const delivered = await waitForStatus(messageId, MessageStatus.DELIVERED);

      expect(delivered.sentAt).toBeInstanceOf(Date);
      expect(delivered.deliveredAt).toBeInstanceOf(Date);
      expect(delivered.gatewayId).toEqual(expect.any(String));

      device.socket.close();
    });

    it('records WHICH SIM sent the message, so history can show from -> to', async () => {
      const device = await connectedDevice();

      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'From and to' })
        .expect(202);

      const messageId = accepted.body.data.id as string;

      const fetched = await request(server)
        .get(`/api/sms/${messageId}`)
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(200);

      expect(fetched.body.data).toMatchObject({
        senderNumber: '+919000000001', // from
        recipient: '+919876543210', // to
      });

      device.socket.close();
    });

    it('leaves senderNumber null when the device does not know its own number', async () => {
      // The common case in the field: Android usually cannot read the SIM's own
      // number, so unless an operator types it in, there is nothing to record.
      // It must come back as an explicit null, not a missing key.
      const user = await seedUser([ApiKeyScope.GATEWAY_CONNECT, ApiKeyScope.SMS_SEND, ApiKeyScope.SMS_READ]);

      const { socket, frames } = await connect(user.apiKey);
      socket.send(JSON.stringify({ type: 'register', deviceId: DEVICE_ID, deviceName: 'Phone', canSendSms: true }));
      await waitForFrame(frames, 'registered');

      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ to: '+919876543210', body: 'Anonymous sender' })
        .expect(202);

      expect(accepted.body.data).toHaveProperty('senderNumber', null);

      const dispatch = await waitForFrame(frames, 'sms.send');
      expect(dispatch.senderNumber).toBeNull();

      socket.close();
    });

    it('records a device-side failure with its error code', async () => {
      const device = await connectedDevice();

      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Doomed' })
        .expect(202);

      const messageId = accepted.body.data.id as string;
      await waitForFrame(device.frames, 'sms.send');

      device.socket.send(
        JSON.stringify({
          type: 'sms.result',
          messageId,
          status: 'FAILED',
          errorCode: 'NO_SERVICE',
          errorMessage: 'The radio has no signal',
        }),
      );

      const failed = await waitForStatus(messageId, MessageStatus.FAILED);
      expect(failed).toMatchObject({ errorCode: 'NO_SERVICE', errorMessage: 'The radio has no signal' });
      expect(failed.failedAt).toBeInstanceOf(Date);

      device.socket.close();
    });

    it('will not let a DELIVERED message be dragged backwards by a late duplicate report', async () => {
      const device = await connectedDevice();

      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Settled' })
        .expect(202);

      const messageId = accepted.body.data.id as string;
      await waitForFrame(device.frames, 'sms.send');

      device.socket.send(JSON.stringify({ type: 'sms.result', messageId, status: 'SENT' }));
      await waitForStatus(messageId, MessageStatus.SENT);
      device.socket.send(JSON.stringify({ type: 'sms.delivered', messageId }));
      await waitForStatus(messageId, MessageStatus.DELIVERED);

      // Android really does re-deliver a sent-receipt. A settled message must not
      // regress to SENT, or the dashboard flickers and the audit trail lies.
      device.socket.send(JSON.stringify({ type: 'sms.result', messageId, status: 'FAILED', errorCode: 'X' }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const still = await repositories().messages.findById(messageId);
      expect(still?.status).toBe(MessageStatus.DELIVERED);
      expect(still?.errorCode).toBeNull();

      device.socket.close();
    });
  });

  // -------------------------------------------------------------------------
  describe('the backlog', () => {
    it('accepts a message with no device connected, then flushes it when one appears', async () => {
      const user = await seedUser([ApiKeyScope.GATEWAY_CONNECT, ApiKeyScope.SMS_SEND]);

      // Nothing is connected. The message must still be accepted - "the phone is
      // in a lift" is not an error the caller should have to handle.
      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ to: '+919876543210', body: 'Waiting for a phone' })
        .expect(202);

      const messageId = accepted.body.data.id as string;
      expect(accepted.body.data.status).toBe(MessageStatus.QUEUED);
      expect(accepted.body.meta.dispatched).toBe(false);

      // Now a phone shows up, and should be handed the backlog on registration.
      const { socket, frames } = await connect(user.apiKey);
      socket.send(JSON.stringify({ type: 'register', deviceId: DEVICE_ID, deviceName: 'Phone', canSendSms: true }));
      await waitForFrame(frames, 'registered');

      const dispatch = await waitForFrame(frames, 'sms.send');
      expect(dispatch.messageId).toBe(messageId);

      await waitForStatus(messageId, MessageStatus.SENDING);

      socket.close();
    });
  });

  // -------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('ignores a device reporting on a message that belongs to someone else', async () => {
      const device = await connectedDevice();

      // Mallory's message, in Mallory's account.
      const mallory = await repositories().users.create({
        email: 'mallory@example.com',
        passwordHash: 'x',
        name: 'Mallory',
        role: 'USER',
        dailySmsLimit: 100,
      });

      const theirs = await repositories().messages.create({
        userId: mallory.id,
        recipient: '+919999999999',
        body: 'Not yours',
        partCount: 1,
        isUnicode: false,
        clientRef: null,
      });

      // Our device claims it failed. The APK is ours; the phone it runs on is not.
      device.socket.send(
        JSON.stringify({ type: 'sms.result', messageId: theirs.id, status: 'FAILED', errorCode: 'HACKED' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const untouched = await repositories().messages.findById(theirs.id);
      expect(untouched?.status).toBe(MessageStatus.QUEUED);
      expect(untouched?.errorCode).toBeNull();

      device.socket.close();
    });
  });

  // -------------------------------------------------------------------------
  describe('multi-SIM routing', () => {
    /** A dual-SIM phone: two labelled numbers on two subscription ids. */
    async function dualSimDevice() {
      const user = await seedUser([ApiKeyScope.GATEWAY_CONNECT, ApiKeyScope.SMS_SEND, ApiKeyScope.SMS_READ]);

      const { socket, frames } = await connect(user.apiKey);
      socket.send(
        JSON.stringify({
          type: 'register',
          deviceId: DEVICE_ID,
          deviceName: 'Dual',
          canSendSms: true,
          sims: [
            { subscriptionId: 1, slot: 1, carrier: 'Vi', phoneNumber: '+919000000001' },
            { subscriptionId: 2, slot: 2, carrier: 'Jio', phoneNumber: '+919000000002' },
          ],
        }),
      );
      await waitForFrame(frames, 'registered');

      return { ...user, socket, frames };
    }

    it('exposes both SIMs on the gateway record', async () => {
      const device = await dualSimDevice();

      const list = await request(server)
        .get('/api/gateways')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .expect(200);

      const sims = list.body.data.gateways[0].sims as { subscriptionId: number; phoneNumber: string }[];
      expect(sims).toHaveLength(2);
      expect(sims.map((s) => s.phoneNumber)).toEqual(['+919000000001', '+919000000002']);

      device.socket.close();
    });

    it('sends from the pinned number, on the right subscriptionId', async () => {
      const device = await dualSimDevice();

      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Pinned', from: '+919000000002' })
        .expect(202);

      expect(accepted.body.data.senderNumber).toBe('+919000000002');

      const dispatch = await waitForFrame(device.frames, 'sms.send');
      // The whole point: the phone is told EXACTLY which SIM to use, not left to
      // pick its default.
      expect(dispatch).toMatchObject({ subscriptionId: 2, senderNumber: '+919000000002' });

      device.socket.close();
    });

    it('fails a pin to a number this account has never labelled', async () => {
      const device = await dualSimDevice();

      const rejected = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Nope', from: '+910000000000' })
        .expect(503);

      // Named, actionable - not a bare 503.
      expect(rejected.body.error.message).toMatch(/No SIM is labelled/i);

      device.socket.close();
    });

    it('refuses to exceed a SIM daily cap, with a 429 rather than a silent queue', async () => {
      const device = await dualSimDevice();

      // Burn SIM #2 to its limit directly, then pin a send to it. The cap is the
      // single mechanism protecting these numbers from being blocked, so "at the
      // limit -> refuse" has to be exact.
      const limit = Number(process.env.SIM_DAILY_SMS_LIMIT ?? 100);
      consume(DEVICE_ID, 2, limit);

      const rejected = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Over', from: '+919000000002' })
        .expect(429);

      expect(rejected.body.error.code).toBe('DAILY_LIMIT_EXCEEDED');

      // The OTHER SIM is untouched and can still send.
      await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Fine', from: '+919000000001' })
        .expect(202);

      device.socket.close();
    });

    it('auto-balances to the SIM with the most quota left when no number is pinned', async () => {
      const device = await dualSimDevice();

      // SIM #1 is nearly spent; the balancer should therefore prefer SIM #2.
      consume(DEVICE_ID, 1, Number(process.env.SIM_DAILY_SMS_LIMIT ?? 100) - 1);

      const accepted = await request(server)
        .post('/api/sms/send')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ to: '+919876543210', body: 'Balance me' })
        .expect(202);

      expect(accepted.body.data.senderNumber).toBe('+919000000002');

      device.socket.close();
    });

    // -----------------------------------------------------------------------
    describe('SIM failover on a rejected send', () => {
      it('retries on the other SIM when the first one rejects the message', async () => {
        const device = await dualSimDevice();

        const accepted = await request(server)
          .post('/api/sms/send')
          .set('Authorization', `Bearer ${device.accessToken}`)
          .send({ to: '+919876543210', body: 'Try both SIMs' })
          .expect(202);
        const messageId = accepted.body.data.id as string;

        // First dispatch lands on SIM #1 (the balancer's default when both are full).
        const first = await waitForFrame(device.frames, 'sms.send');
        expect(first).toMatchObject({ messageId, subscriptionId: 1, senderNumber: '+919000000001' });

        // That SIM's radio rejects it - no signal on that carrier, say.
        device.socket.send(
          JSON.stringify({ type: 'sms.result', messageId, status: 'FAILED', errorCode: 'NO_SERVICE' }),
        );

        // It must be re-dispatched to SIM #2, NOT marked FAILED.
        const second = await waitForSendTo(device.frames, 2);
        expect(second).toMatchObject({ messageId, subscriptionId: 2, senderNumber: '+919000000002' });

        const retried = await repositories().messages.findById(messageId);
        expect(retried?.status).toBe(MessageStatus.SENDING);
        expect(retried?.attempts).toBe(2);
        expect(retried?.senderNumber).toBe('+919000000002');

        // SIM #2 accepts it, and the message settles SENT.
        device.socket.send(JSON.stringify({ type: 'sms.result', messageId, status: 'SENT' }));
        const sent = await waitForStatus(messageId, MessageStatus.SENT);
        expect(sent.senderNumber).toBe('+919000000002');

        device.socket.close();
      });

      it('gives up with FAILED once every SIM has rejected it', async () => {
        const device = await dualSimDevice();

        const accepted = await request(server)
          .post('/api/sms/send')
          .set('Authorization', `Bearer ${device.accessToken}`)
          .send({ to: '+919876543210', body: 'Doomed everywhere' })
          .expect(202);
        const messageId = accepted.body.data.id as string;

        await waitForFrame(device.frames, 'sms.send'); // SIM #1
        device.socket.send(
          JSON.stringify({ type: 'sms.result', messageId, status: 'FAILED', errorCode: 'NO_SERVICE' }),
        );

        await waitForSendTo(device.frames, 2); // failover to SIM #2
        device.socket.send(
          JSON.stringify({ type: 'sms.result', messageId, status: 'FAILED', errorCode: 'NO_SERVICE' }),
        );

        // Both SIMs tried, nothing left: now it is genuinely FAILED.
        const failed = await waitForStatus(messageId, MessageStatus.FAILED);
        expect(failed.attempts).toBe(2);
        expect(failed.errorCode).toBe('NO_SERVICE');

        device.socket.close();
      });

      it('does NOT fail a pinned send over to a different SIM', async () => {
        const device = await dualSimDevice();

        const accepted = await request(server)
          .post('/api/sms/send')
          .set('Authorization', `Bearer ${device.accessToken}`)
          .send({ to: '+919876543210', body: 'Must be this number', from: '+919000000001' })
          .expect(202);
        const messageId = accepted.body.data.id as string;

        await waitForFrame(device.frames, 'sms.send'); // pinned to SIM #1
        device.socket.send(
          JSON.stringify({ type: 'sms.result', messageId, status: 'FAILED', errorCode: 'NO_SERVICE' }),
        );

        // A pin means "this number or nothing" - it must NOT be re-sent from SIM #2.
        const failed = await waitForStatus(messageId, MessageStatus.FAILED);
        expect(failed.attempts).toBe(1);

        const dispatches = device.frames.filter((f) => f.type === 'sms.send');
        expect(dispatches).toHaveLength(1);

        device.socket.close();
      });

      it('does NOT retry a GENERIC_FAILURE on another SIM - it may already have gone out', async () => {
        const device = await dualSimDevice();

        const accepted = await request(server)
          .post('/api/sms/send')
          .set('Authorization', `Bearer ${device.accessToken}`)
          .send({ to: '+919876543210', body: 'Ambiguous failure' })
          .expect(202);
        const messageId = accepted.body.data.id as string;

        await waitForFrame(device.frames, 'sms.send'); // SIM #1

        // GENERIC_FAILURE is the modem's catch-all, and it is reported for
        // messages that DID leave the radio. Retrying on SIM #2 is what sent the
        // same person the same promo twice - only ever on auto-balance, because a
        // pinned send never fails over at all.
        device.socket.send(
          JSON.stringify({ type: 'sms.result', messageId, status: 'FAILED', errorCode: 'GENERIC_FAILURE' }),
        );

        const failed = await waitForStatus(messageId, MessageStatus.FAILED);
        expect(failed.attempts).toBe(1);
        expect(failed.errorCode).toBe('GENERIC_FAILURE');

        const dispatches = device.frames.filter((f) => f.type === 'sms.send');
        expect(dispatches).toHaveLength(1);

        device.socket.close();
      });

      it('does not fan out when the same failure is reported twice', async () => {
        const device = await dualSimDevice();

        const accepted = await request(server)
          .post('/api/sms/send')
          .set('Authorization', `Bearer ${device.accessToken}`)
          .send({ to: '+919876543210', body: 'Reported twice' })
          .expect(202);
        const messageId = accepted.body.data.id as string;

        await waitForFrame(device.frames, 'sms.send'); // SIM #1

        // Android delivers a sent-receipt more than once often enough to matter.
        // Two reports must still produce ONE retry, not one per report.
        const failure = JSON.stringify({
          type: 'sms.result',
          messageId,
          status: 'FAILED',
          errorCode: 'NO_SERVICE',
        });
        device.socket.send(failure);
        device.socket.send(failure);

        await waitForSendTo(device.frames, 2);

        const retried = await repositories().messages.findById(messageId);
        expect(retried?.attempts).toBe(2);

        const dispatches = device.frames.filter((f) => f.type === 'sms.send');
        expect(dispatches).toHaveLength(2);

        device.socket.close();
      });

      it('records WHICH line carried the message, not just the number it was labelled with', async () => {
        const device = await dualSimDevice();

        const accepted = await request(server)
          .post('/api/sms/send')
          .set('Authorization', `Bearer ${device.accessToken}`)
          .send({ to: '+919876543210', body: 'Stamped', from: '+919000000002' })
          .expect(202);
        const messageId = accepted.body.data.id as string;

        await waitForFrame(device.frames, 'sms.send');

        // This pair - not senderNumber, which is a hand-typed label - is what the
        // per-SIM daily counters are computed from.
        const stamped = await repositories().messages.findById(messageId);
        expect(stamped?.senderDeviceId).toBe(DEVICE_ID);
        expect(stamped?.senderSubscriptionId).toBe(2);
        expect(stamped?.dispatchedAt).not.toBeNull();

        device.socket.close();
      });
    });
  });
});
