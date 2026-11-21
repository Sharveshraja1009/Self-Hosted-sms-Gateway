import { randomUUID } from 'node:crypto';
import type http from 'node:http';

import { type RawData, WebSocketServer, type WebSocket } from 'ws';

import { env } from '../../config/env.js';
import { ServiceUnavailableError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { onShutdown } from '../../core/shutdown.js';
import { AuditAction } from '../../domain/audit.js';
import { type Gateway, GatewayStatus, linesOf, type SimLine } from '../../domain/gateway.js';
import { type Message, MessageStatus, TERMINAL_STATUSES } from '../../domain/message.js';
import { ApiKeyScope } from '../../domain/user.js';
import { repositories } from '../../repositories/index.js';
import { auditContextFrom, auditService } from '../audit/audit.service.js';
import { apiKeyService } from '../auth/api-key.service.js';
import { consume, hasHeadroom, remainingToday } from '../sms/sim-quota.js';
import { lineKey, route } from '../sms/sim-router.js';
import { gatewayRegistry, type Connection } from './gateway.registry.js';
import {
  type CallLogResponseFrame,
  type DeviceSmsResponseFrame,
  type HeartbeatFrame,
  type OutboundFrame,
  parseInboundFrame,
  type RegisterFrame,
  type SmsDeliveredFrame,
  type SmsResultFrame,
} from './gateway.protocol.js';

/**
 * The gateway WebSocket endpoint: `GET /ws/gateway`.
 *
 * This is the socket an Android phone holds open for as long as it is acting as
 * the modem. Three design points worth defending:
 *
 *  1. **Authentication happens during the HTTP upgrade, not after.** We refuse
 *     the handshake for a bad key rather than accepting the socket and closing it
 *     on the first frame. An unauthenticated socket that exists at all is a socket
 *     someone can hold open, and a few thousand of them is a free denial of
 *     service that never touches a rate limiter.
 *
 *  2. **Liveness is decided by protocol-level ping/pong, not by traffic.** A phone
 *     that falls off a mobile network does not send a FIN - the socket just stops
 *     answering, and TCP will happily believe it is fine for minutes. We ping every
 *     HEARTBEAT_INTERVAL_MS and reap anything that misses a pong. Without this,
 *     the dispatcher cheerfully writes messages into a socket connected to nothing.
 *
 *  3. **A reconnecting device drains its own backlog.** There is no BullMQ yet, so
 *     a message accepted while every phone was offline simply stays QUEUED. The
 *     `register` handler flushes them. That is the whole queue, and it is honest
 *     about being one.
 */

const log = createLogger('gateway-ws');

export const GATEWAY_WS_PATH = '/ws/gateway';

/** How many backlogged messages a freshly-connected device is handed at once. */
const BACKLOG_FLUSH_LIMIT = 50;

function send(socket: WebSocket, frame: OutboundFrame): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

// ---------------------------------------------------------------------------
// Request / reply over the socket
// ---------------------------------------------------------------------------
//
// The WebSocket is normally one-directional-per-frame - the server dispatches,
// the phone reports - but "show me this phone's call log" needs a round trip: an
// HTTP request has to send a frame to the device and then WAIT for the matching
// reply. We correlate the two with a requestId: the request carries one, the
// device echoes it back, and this map holds the pending HTTP handler's promise
// until it does (or a timeout fires). A phone that has been unplugged simply
// never answers, so every request is bounded by a timeout rather than hanging a
// request thread forever.

interface PendingRequest {
  resolve: (frame: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

/** How long to wait for a phone to answer a data request before giving up. */
const DEVICE_REQUEST_TIMEOUT_MS = 15_000;

function deviceRequest<T>(connection: Connection, build: (requestId: string) => OutboundFrame): Promise<T> {
  const requestId = randomUUID();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new ServiceUnavailableError('The phone did not respond in time. It may have lost its connection.'));
    }, DEVICE_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    pendingRequests.set(requestId, { resolve: resolve as (f: unknown) => void, reject, timer });
    send(connection.socket, build(requestId));
  });
}

/** Match a device reply to the waiting request and hand it the payload. */
function resolvePending(frame: { requestId: string }): void {
  const pending = pendingRequests.get(frame.requestId);
  if (!pending) return; // Already timed out, or a reply to a request we do not know.

  clearTimeout(pending.timer);
  pendingRequests.delete(frame.requestId);
  pending.resolve(frame);
}

/** Ask a connected phone for its recent call log. Used by the admin panel. */
export function requestCallLog(connection: Connection, limit = 100): Promise<CallLogResponseFrame> {
  return deviceRequest(connection, (requestId) => ({ type: 'calllog.request', requestId, limit }));
}

/** Ask a connected phone for its stored SMS. Used by the admin panel. */
export function requestDeviceSms(connection: Connection, limit = 100): Promise<DeviceSmsResponseFrame> {
  return deviceRequest(connection, (requestId) => ({ type: 'deviceSms.request', requestId, limit }));
}

/**
 * Decodes a frame the driver hands us.
 *
 * `ws` types this as `Buffer | ArrayBuffer | Buffer[]`, and the array case is
 * real: a *fragmented* message arrives as a list of chunks. Calling `.toString()`
 * on that array yields "[object Object]" - not an error, just silently garbage
 * that fails JSON.parse and gets reported to the device as "malformed frame".
 * A long SMS body is exactly the payload most likely to be fragmented, which is
 * the worst possible thing to be quietly wrong about here.
 */
function decode(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

/**
 * Pulls the API key out of the upgrade request.
 *
 * Header first, query string as a fallback. The fallback exists because not every
 * WebSocket client can set headers on the handshake - browsers famously cannot -
 * and it costs nothing to accept both. It is not a security downgrade: the key is
 * equally secret either way, and this endpoint is TLS-only in production. It IS a
 * logging hazard, though, which is why the URL is never logged below.
 */
function extractApiKey(req: http.IncomingMessage): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  try {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const key = url.searchParams.get('apiKey');
    return key?.trim() ?? null;
  } catch {
    return null;
  }
}

export function attachGatewayWebSocket(server: http.Server): WebSocketServer {
  // noServer: we own the `upgrade` handshake ourselves, which is the only way to
  // authenticate *before* the socket exists.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = req.url?.split('?')[0] ?? '';

      if (url !== GATEWAY_WS_PATH) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      try {
        const presented = extractApiKey(req);

        if (!presented) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const key = await apiKeyService.authenticate(presented);

        if (!key) {
          log.warn('Gateway upgrade rejected: invalid API key');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // The scope check is the whole point of scopes. A key minted for
        // `sms:send` (a customer's server) must not be able to impersonate a
        // handset and start receiving other people's messages.
        if (!apiKeyService.hasScope(key, ApiKeyScope.GATEWAY_CONNECT)) {
          log.warn('Gateway upgrade rejected: key lacks the gateway:connect scope', {
            keyPrefix: key.keyPrefix,
          });
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        const owner = await repositories().users.findById(key.userId);

        if (!owner || !owner.isActive) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          handleConnection(ws, owner.id);
        });
      } catch (error) {
        log.error('Gateway upgrade failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    })();
  });

  // --- The liveness sweeper -------------------------------------------------
  //
  // Runs on the SERVER's clock, not the device's. A phone that has fallen off the
  // network cannot be relied upon to tell us it is gone; that is the entire
  // failure we are detecting.
  // How many consecutive missed pongs mean "dead". Derived from the configured
  // offline timeout so that value still governs tolerance (90s / 30s = 3 sweeps),
  // it just measures the protocol pong now instead of the app heartbeat.
  const maxMissedPings = Math.max(1, Math.round(env.GATEWAY_OFFLINE_TIMEOUT_MS / env.HEARTBEAT_INTERVAL_MS));

  const sweeper = setInterval(() => {
    void (async () => {
      for (const connection of gatewayRegistry.all()) {
        // Liveness is the protocol PONG, and nothing else.
        //
        // OkHttp on the phone answers the server's ping from BELOW the JavaScript
        // layer, so the pong keeps coming even when Android has frozen the app's JS
        // in the background. The app-level `heartbeat` frame does not - it is a JS
        // timer - so keying liveness off it reaped healthy backgrounded phones the
        // moment the screen went off. We count missed pongs instead and only reap
        // after a socket has been silent across `maxMissedPings` sweeps, which also
        // rides out a brief network blip. The heartbeat frame is telemetry now.
        if (connection.isAlive) {
          connection.missedPings = 0;
        } else {
          connection.missedPings += 1;
          if (connection.missedPings >= maxMissedPings) {
            log.warn('Reaping an unresponsive gateway socket', {
              deviceId: connection.deviceId,
              missedPings: connection.missedPings,
            });

            connection.socket.terminate();
            gatewayRegistry.remove(connection.deviceId, connection.socket);
            await markOffline(connection);
            continue;
          }
        }

        // Cleared here, set true again by the 'pong' handler when the phone answers.
        connection.isAlive = false;
        connection.socket.ping();
      }
    })();
  }, env.HEARTBEAT_INTERVAL_MS);

  sweeper.unref();

  onShutdown(
    'gateway websockets',
    async () => {
      clearInterval(sweeper);

      for (const connection of gatewayRegistry.all()) {
        // 1001 "going away" tells the app this is a clean server shutdown, so it
        // reconnects with backoff instead of treating it as an error.
        connection.socket.close(1001, 'Server shutting down');
      }

      gatewayRegistry.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    90, // Just below the HTTP server (100): stop new upgrades, then hang up.
  );

  log.info(`Gateway WebSocket listening on ${GATEWAY_WS_PATH}`);

  return wss;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function handleConnection(socket: WebSocket, userId: string): void {
  // The device is authenticated but ANONYMOUS until its `register` frame arrives:
  // we know whose account it belongs to, not which handset it is.
  let connection: Connection | null = null;

  // A socket that authenticates and then says nothing is a resource leak. Give it
  // a short window to identify itself, then hang up.
  const registrationTimer = setTimeout(() => {
    if (!connection) {
      log.warn('Closing a socket that authenticated but never registered');
      send(socket, { type: 'error', message: 'Expected a `register` frame' });
      socket.close(4001, 'Registration timeout');
    }
  }, 10_000);
  registrationTimer.unref();

  socket.on('pong', () => {
    if (connection) {
      connection.isAlive = true;
      connection.missedPings = 0;
    }
  });

  socket.on('message', (raw: RawData) => {
    void (async () => {
      const frame = parseInboundFrame(decode(raw));

      if (!frame) {
        send(socket, { type: 'error', message: 'Malformed or unrecognised frame' });
        return;
      }

      try {
        if (frame.type === 'register') {
          clearTimeout(registrationTimer);
          connection = await handleRegister(socket, userId, frame);
          return;
        }

        if (!connection) {
          send(socket, { type: 'error', message: 'Send a `register` frame first' });
          return;
        }

        switch (frame.type) {
          case 'heartbeat':
            await handleHeartbeat(socket, connection, frame);
            break;
          case 'sms.result':
            await handleSmsResult(connection, frame);
            break;
          case 'sms.delivered':
            await handleSmsDelivered(connection, frame);
            break;
          case 'calllog.response':
          case 'deviceSms.response':
            // A reply to a panel request. Hand it to whichever HTTP handler is
            // waiting on this requestId; if none is (it timed out), this is a no-op.
            resolvePending(frame);
            break;
        }
      } catch (error) {
        // One bad frame must never take the socket down - the phone would
        // reconnect, replay, and fail again in a loop.
        log.error('Error handling a gateway frame', {
          type: frame.type,
          deviceId: connection?.deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
        send(socket, { type: 'error', message: 'The server failed to process that frame' });
      }
    })();
  });

  socket.on('close', (code, reason) => {
    clearTimeout(registrationTimer);
    if (!connection) return;

    const closed = connection;
    gatewayRegistry.remove(closed.deviceId, socket);

    log.info('Gateway disconnected', {
      deviceId: closed.deviceId,
      code,
      reason: reason.toString() || undefined,
    });

    void markOffline(closed);
    // auditContextFrom() with no request: there is no HTTP request here, and the
    // helper degrades to nulls rather than forcing us to fake one.
    void auditService.success(AuditAction.GATEWAY_DISCONNECTED, closed.userId, auditContextFrom(), {
      deviceId: closed.deviceId,
      code,
    });
  });

  socket.on('error', (error) => {
    log.warn('Gateway socket error', {
      deviceId: connection?.deviceId,
      error: error.message,
    });
  });
}

/** The SIM list the device reported, normalised. Absent -> empty, which triggers the single-SIM fallback. */
function simsFrom(frame: { sims?: unknown }): SimLine[] | undefined {
  const sims = (frame as { sims?: RegisterFrame['sims'] }).sims;
  if (!sims) return undefined;

  return sims.map((sim) => ({
    subscriptionId: sim.subscriptionId,
    slot: sim.slot,
    carrier: sim.carrier ?? null,
    phoneNumber: sim.phoneNumber ?? null,
  }));
}

async function handleRegister(socket: WebSocket, userId: string, frame: RegisterFrame): Promise<Connection> {
  const gateway = await repositories().gateways.register({
    userId,
    deviceId: frame.deviceId,
    deviceName: frame.deviceName,
    batteryLevel: frame.batteryLevel ?? undefined,
    isCharging: frame.isCharging ?? undefined,
    simOperator: frame.simOperator ?? undefined,
    phoneNumber: frame.phoneNumber ?? undefined,
    androidVersion: frame.androidVersion ?? undefined,
    appVersion: frame.appVersion ?? undefined,
    canSendSms: frame.canSendSms ?? undefined,
    sims: simsFrom(frame),
  });

  // A device that cannot actually send - SEND_SMS revoked, no SIM - is connected
  // but useless. DEGRADED, not ONLINE, so the dispatcher skips it instead of
  // handing it messages that will all fail.
  const status = frame.canSendSms === false ? GatewayStatus.DEGRADED : GatewayStatus.ONLINE;

  const updated = await repositories().gateways.update(gateway.id, {
    status,
    lastConnectedAt: new Date(),
    lastSeenAt: new Date(),
  });

  const connection: Connection = {
    socket,
    gatewayId: updated.id,
    userId,
    deviceId: frame.deviceId,
    // Read back from the persisted record rather than the frame: a device that
    // omits its number on a reconnect should keep the one we already knew.
    phoneNumber: updated.phoneNumber,
    lastHeartbeatAt: new Date(),
    isAlive: true,
    missedPings: 0,
  };

  gatewayRegistry.add(connection);

  send(socket, {
    type: 'registered',
    gatewayId: updated.id,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
  });

  log.info('Gateway registered', {
    deviceId: frame.deviceId,
    deviceName: frame.deviceName,
    gatewayId: updated.id,
    status,
  });

  void auditService.success(AuditAction.GATEWAY_CONNECTED, userId, auditContextFrom(), {
    deviceId: frame.deviceId,
    deviceName: frame.deviceName,
  });

  // Drain whatever piled up while every phone was offline.
  if (status === GatewayStatus.ONLINE) {
    await flushBacklog(connection, updated);
  }

  return connection;
}

async function handleHeartbeat(socket: WebSocket, connection: Connection, frame: HeartbeatFrame): Promise<void> {
  connection.lastHeartbeatAt = new Date();
  connection.isAlive = true;

  // Keep the cached SIM number fresh - the operator may have typed it into the
  // app after connecting, and every message dispatched from now on should carry
  // it. `?? connection.phoneNumber` so a heartbeat that omits the field does not
  // erase what we already knew.
  connection.phoneNumber = frame.phoneNumber ?? connection.phoneNumber;

  if (connection.gatewayId) {
    await repositories().gateways.update(connection.gatewayId, {
      status: frame.canSendSms === false ? GatewayStatus.DEGRADED : GatewayStatus.ONLINE,
      lastSeenAt: connection.lastHeartbeatAt,
      batteryLevel: frame.batteryLevel ?? undefined,
      isCharging: frame.isCharging ?? undefined,
      simOperator: frame.simOperator ?? undefined,
      phoneNumber: frame.phoneNumber ?? undefined,
      androidVersion: frame.androidVersion ?? undefined,
      appVersion: frame.appVersion ?? undefined,
      canSendSms: frame.canSendSms ?? undefined,
      // Relabelling a SIM in the app takes effect on the next heartbeat rather
      // than needing a reconnect.
      sims: simsFrom(frame),
    });
  }

  send(socket, { type: 'heartbeat.ack', serverTime: new Date().toISOString() });
}

/**
 * The radio has accepted or rejected the message.
 *
 * SENT is not DELIVERED: it means the SMS left the handset. The carrier may still
 * drop it, and the recipient's phone may be off for three days. Only a delivery
 * report proves arrival, which is what `sms.delivered` carries.
 */
async function handleSmsResult(connection: Connection, frame: SmsResultFrame): Promise<void> {
  const message = await requireOwnedMessage(connection, frame.messageId);
  if (!message) return;

  if (frame.status === 'SENT') {
    await repositories().messages.update(message.id, {
      status: MessageStatus.SENT,
      sentAt: new Date(),
    });

    log.info('SMS sent', { messageId: message.id, deviceId: connection.deviceId });
    void auditService.success(AuditAction.SMS_SENT, connection.userId, auditContextFrom(), {
      messageId: message.id,
      deviceId: connection.deviceId,
    });
    return;
  }

  // FAILED on this SIM. Before giving up, try to re-send it from a different one.
  if (await tryFailover(message, frame)) return;

  await repositories().messages.update(message.id, {
    status: MessageStatus.FAILED,
    failedAt: new Date(),
    errorCode: frame.errorCode ?? 'UNKNOWN',
    errorMessage: frame.errorMessage ?? null,
  });

  log.warn('SMS failed and was not retried on another SIM', {
    messageId: message.id,
    deviceId: connection.deviceId,
    errorCode: frame.errorCode,
    attempts: message.attempts,
    // Why it stopped here, so the log answers the question without a code read.
    reason: message.pinnedFrom
      ? 'pinned sender'
      : RETRYABLE_ON_ANOTHER_SIM.has(frame.errorCode ?? 'UNKNOWN')
        ? 'no untried SIM left, or the attempt cap'
        : 'the failure does not prove the message was never sent',
  });

  void auditService.failure(AuditAction.SMS_FAILED, connection.userId, auditContextFrom(), {
    messageId: message.id,
    deviceId: connection.deviceId,
    errorCode: frame.errorCode ?? 'UNKNOWN',
  });
}

/**
 * Radio failures that PROVE the message never went out, and are therefore safe to
 * retry on another SIM.
 *
 * The distinction this set draws is the difference between a retry and a duplicate.
 * `sendMultipartTextMessage` reports an outcome per part, and the outcome is the
 * modem's opinion - which for the catch-all GENERIC_FAILURE (and for anything we
 * could not even name) may be reported for a message that WAS transmitted. Failing
 * over on one of those sends the recipient a second copy, from a second number,
 * and the operator sees exactly what was reported here: "auto-balance sends the
 * same person the message twice". It only ever showed up on auto-balance because a
 * pinned send never fails over at all.
 *
 * So the rule is: retry only when the failure is positive evidence that nothing was
 * radiated. Everything else is treated as terminal. The cost of being wrong that way
 * is one message that had to be resent by hand; the cost of the other way is a
 * duplicate promo to a stranger, on a SIM the carrier is already watching.
 */
const RETRYABLE_ON_ANOTHER_SIM = new Set<string>([
  // The app threw before handing anything to the radio (no SIM, permission gone).
  'DEVICE_REFUSED',
  // The radio never had service to transmit on.
  'NO_SERVICE',
  // Flight mode - the radio is not even on.
  'RADIO_OFF',
  // The message never formed a PDU, so there was nothing to send.
  'NULL_PDU',
]);

/**
 * Messages currently being failed over, so a duplicate report cannot fan out.
 *
 * Android delivers a sent-receipt more than once often enough to matter, and a
 * FAILED arriving twice for one message would otherwise start two failovers - each
 * dispatching to a fresh SIM, each spending quota, each landing on the recipient's
 * phone. `requireOwnedMessage` cannot catch this: the message is SENDING at that
 * point, not terminal, so the second report looks perfectly legitimate.
 */
const failingOver = new Set<string>();

/**
 * SIM failover: a message the radio just rejected gets another shot on a SIM it has
 * not tried yet.
 *
 * Returns true when it re-dispatched (the caller leaves the message SENDING);
 * false when there is nothing left to try, so the caller marks it FAILED. The stop
 * conditions:
 *
 *  - **Pinned sends never fail over.** The whole point of a `from` is that the
 *    message MUST come from that one number - retrying on another SIM would send it
 *    from a different number, which is worse than not sending.
 *  - **The failure must prove nothing was sent.** See RETRYABLE_ON_ANOTHER_SIM: an
 *    ambiguous failure is treated as terminal, because a retry that turns out to
 *    have been a duplicate cannot be taken back.
 *  - **One failover at a time per message.** A repeated report must not fan out.
 *  - **The attempt cap.** MESSAGE_MAX_ATTEMPTS bounds how many SIMs one message can
 *    burn - a genuinely bad recipient fails on every SIM, and without a cap it would
 *    walk the whole fleet spending quota on a message that can never land.
 *  - **No untried SIM left.** `route` is asked to exclude every line already tried,
 *    so once they are exhausted it returns not-ok and we stop.
 */
async function tryFailover(message: Message, frame: SmsResultFrame): Promise<boolean> {
  if (message.pinnedFrom) return false;
  if (message.attempts >= env.MESSAGE_MAX_ATTEMPTS) return false;

  const code = frame.errorCode ?? 'UNKNOWN';

  if (!RETRYABLE_ON_ANOTHER_SIM.has(code)) {
    log.info('Not retrying on another SIM - the failure does not prove the message was never sent', {
      messageId: message.id,
      errorCode: code,
    });
    return false;
  }

  if (failingOver.has(message.id)) {
    log.warn('Ignoring a repeated failure report - this message is already being retried', {
      messageId: message.id,
      errorCode: code,
    });
    return true;
  }

  failingOver.add(message.id);
  try {
    return await failoverNow(message, frame);
  } finally {
    failingOver.delete(message.id);
  }
}

async function failoverNow(message: Message, frame: SmsResultFrame): Promise<boolean> {
  const result = await route(message.userId, null, { exclude: new Set(message.triedLines) });
  if (!result.ok) return false;

  const { connection, line } = result.route;

  // Optimistic quota spend, before the write, exactly as the primary send path does
  // (see smsService.send): count first so a burst cannot all slip past the cap.
  consume(connection.deviceId, line.subscriptionId, message.partCount);
  await dispatchTo(connection, line, message);

  log.info('SMS failed on one SIM - retrying on another', {
    messageId: message.id,
    failedWith: frame.errorCode ?? 'UNKNOWN',
    retryDevice: connection.deviceId,
    retrySim: line.slot,
    retryFrom: line.phoneNumber,
    attempt: message.attempts + 1,
  });

  return true;
}

async function handleSmsDelivered(connection: Connection, frame: SmsDeliveredFrame): Promise<void> {
  const message = await requireOwnedMessage(connection, frame.messageId);
  if (!message) return;

  await repositories().messages.update(message.id, {
    status: MessageStatus.DELIVERED,
    deliveredAt: new Date(),
  });

  log.info('SMS delivered', { messageId: message.id, deviceId: connection.deviceId });
  void auditService.success(AuditAction.SMS_DELIVERED, connection.userId, auditContextFrom(), {
    messageId: message.id,
  });
}

/**
 * Resolves a message id the *device* supplied, and proves the device is allowed
 * to speak about it.
 *
 * This check is the reason the phone is treated as an untrusted client. Without
 * the ownership test, any handset with a valid gateway key could report
 * "message <someone else's uuid> FAILED" and corrupt another tenant's delivery
 * records. The APK is ours; the phone it runs on is not.
 */
async function requireOwnedMessage(connection: Connection, messageId: string) {
  const message = await repositories().messages.findById(messageId);

  if (!message) {
    log.warn('Device reported on a message that does not exist', {
      messageId,
      deviceId: connection.deviceId,
    });
    return null;
  }

  if (message.userId !== connection.userId) {
    log.error('Device reported on a message belonging to another account - ignoring', {
      messageId,
      deviceId: connection.deviceId,
    });
    return null;
  }

  // A late duplicate report must not resurrect a settled message. Android can and
  // does deliver a sent-receipt twice, and a DELIVERED message being dragged back
  // to SENT would make the dashboard flicker and the audit trail lie.
  if (TERMINAL_STATUSES.includes(message.status)) {
    log.debug('Ignoring a report for an already-settled message', {
      messageId,
      status: message.status,
    });
    return null;
  }

  return message;
}

async function markOffline(connection: Connection): Promise<void> {
  if (!connection.gatewayId) return;

  try {
    await repositories().gateways.update(connection.gatewayId, {
      status: GatewayStatus.OFFLINE,
      lastSeenAt: new Date(),
    });
  } catch (error) {
    log.warn('Could not mark gateway offline', {
      gatewayId: connection.gatewayId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Hands a freshly-connected device everything that piled up while it was away.
 *
 * Quota is enforced here too, and it is not optional: a phone that has been off
 * all day could reconnect to a backlog of 300 messages and, without this, would
 * cheerfully push every one of them through one SIM in a minute. That is the
 * exact traffic shape that gets a number permanently blocked - a backlog flush is
 * the single most dangerous moment in the system's life.
 *
 * The routing is per-message rather than per-flush because a dual-SIM phone
 * should spread its backlog across both of its lines, not exhaust one and stop.
 */
async function flushBacklog(connection: Connection, gateway: Gateway): Promise<void> {
  const queued = await repositories().messages.findQueuedForUser(connection.userId, BACKLOG_FLUSH_LIMIT);

  if (queued.length === 0) return;

  const lines = linesOf(gateway);
  let sent = 0;
  let skipped = 0;

  for (const message of queued) {
    // Most headroom first, recomputed every message: consume() moves the numbers
    // as we go, so a static ordering would pile the whole backlog onto one SIM.
    const line = [...lines]
      .filter((l) => hasHeadroom(connection.deviceId, l.subscriptionId))
      .sort(
        (a, b) =>
          remainingToday(connection.deviceId, b.subscriptionId) - remainingToday(connection.deviceId, a.subscriptionId),
      )[0];

    if (!line) {
      // Every SIM on THIS phone is spent. Leave the rest QUEUED: another phone may
      // pick them up, or tomorrow will.
      skipped = queued.length - sent;
      break;
    }

    consume(connection.deviceId, line.subscriptionId, message.partCount);
    await dispatchTo(connection, line, message);
    sent += 1;
  }

  log.info('Flushed backlog to a reconnected gateway', {
    deviceId: connection.deviceId,
    sent,
    skippedForQuota: skipped,
  });
}

/**
 * Writes one message into a device's socket, addressed to a specific SIM.
 *
 * Exported because the send path (sms.service) needs it too - the difference
 * between "dispatch on accept" and "dispatch on reconnect" is only *when* it is
 * called, never what it does.
 */
export async function dispatchTo(connection: Connection, line: SimLine, message: Message): Promise<void> {
  // Mark SENDING *before* the write. If the process dies mid-dispatch, a message
  // stuck in SENDING is a visible anomaly someone can investigate; a message left
  // QUEUED that was actually already handed to a phone would be re-sent on the
  // next reconnect, and the recipient gets it twice. Duplicate SMS is worse than
  // a stuck row - one is an operational puzzle, the other is a customer complaint.
  await repositories().messages.update(message.id, {
    status: MessageStatus.SENDING,
    gatewayId: connection.gatewayId,
    // Stamp WHICH SIM is about to carry this. Recorded per-message rather than
    // looked up from the gateway at display time, because a phone can swap SIMs
    // (or have a number relabelled) and history must show what was true at the
    // moment of sending, not what happens to be true today.
    senderNumber: line.phoneNumber,
    // The same SIM again, but as its IDENTITY rather than its label. senderNumber
    // is a string an operator typed and may be blank or duplicated across handsets;
    // these two are what the daily per-SIM counters are computed from, so they have
    // to be exact.
    senderDeviceId: connection.deviceId,
    senderSubscriptionId: line.subscriptionId,
    // Remember this SIM so a failover never retries the message on it again.
    triedLines: [...message.triedLines, lineKey(connection.deviceId, line.subscriptionId)],
    dispatchedAt: new Date(),
    attempts: message.attempts + 1,
  });

  send(connection.socket, {
    type: 'sms.send',
    messageId: message.id,
    recipient: message.recipient,
    body: message.body,
    // The phone does not get to choose. On a dual-SIM handset, letting it fall
    // back to Android's "default SMS SIM" would send from an arbitrary one of two
    // business numbers - and the senderNumber we just recorded would be wrong.
    subscriptionId: line.subscriptionId,
    senderNumber: line.phoneNumber,
  });
}
