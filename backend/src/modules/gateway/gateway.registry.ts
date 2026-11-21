import type { WebSocket } from 'ws';

import { createLogger } from '../../core/logger.js';

/**
 * The live-connection registry.
 *
 * This is the *only* mutable in-memory state in the application, and it is
 * in-memory on purpose: a WebSocket is a property of one Node process, not of the
 * cluster. Persisting "which socket is open" to MongoDB would produce a table
 * that is wrong the instant a process dies - which is exactly why the durable
 * `Gateway` record (status, telemetry, last seen) lives in the database and the
 * *socket* lives here.
 *
 * The consequence, stated plainly because it will bite someone later: with two
 * backend replicas, a message accepted by replica A cannot be dispatched to a
 * phone connected to replica B. Making that work needs a Redis pub/sub fan-out on
 * the dispatch path - which is Phase 4's job, and precisely why Redis is already
 * in the compose file. Until then, run one replica.
 */

const log = createLogger('gateway-registry');

export interface Connection {
  socket: WebSocket;
  /** The persistent Gateway id. Null until the device sends its `register` frame. */
  gatewayId: string | null;
  userId: string;
  deviceId: string;
  /**
   * The SIM's own number, as the device reported it. Usually null - Android
   * rarely knows its own number - unless the operator typed it into the app.
   * Cached here so the dispatch path can stamp it onto the message without a
   * database round-trip on every send.
   */
  phoneNumber: string | null;
  /** Bumped on every heartbeat. The offline sweeper reads this. */
  lastHeartbeatAt: Date;
  /** Answered the last protocol-level ping? Cleared before each ping, set on pong. */
  isAlive: boolean;
  /**
   * Consecutive liveness sweeps with no pong. Reset to 0 on every pong; the sweeper
   * reaps the socket once this crosses the offline threshold. This - the protocol
   * pong - is what decides liveness, NOT the app-level heartbeat: Android can freeze
   * a backgrounded app's JS (and with it the heartbeat) while the socket stays open
   * and keeps answering pings, so reaping on a stale heartbeat killed healthy phones.
   */
  missedPings: number;
}

class GatewayRegistry {
  /** deviceId -> connection. One socket per device: a reconnect replaces, never duplicates. */
  private readonly connections = new Map<string, Connection>();

  /**
   * Registers a live socket, closing any previous one for the same device.
   *
   * The replace-don't-duplicate rule matters: a phone whose network flaps
   * reconnects before the old socket's TCP timeout fires, so for a while the
   * server holds two sockets to one handset. Dispatching to the stale one means
   * the SMS silently never sends. Last writer wins, and the loser is hung up on.
   */
  add(connection: Connection): void {
    const existing = this.connections.get(connection.deviceId);

    if (existing && existing.socket !== connection.socket) {
      log.warn('Device reconnected while an older socket was still open - closing the stale one', {
        deviceId: connection.deviceId,
      });
      existing.socket.close(4000, 'Replaced by a newer connection');
    }

    this.connections.set(connection.deviceId, connection);
  }

  /** Removes a socket, but only if it is still the *current* one for that device. */
  remove(deviceId: string, socket: WebSocket): void {
    const existing = this.connections.get(deviceId);

    // Guard against the stale-socket close handler firing *after* the replacement
    // registered, which would otherwise evict a perfectly healthy connection.
    if (existing && existing.socket === socket) {
      this.connections.delete(deviceId);
    }
  }

  get(deviceId: string): Connection | undefined {
    return this.connections.get(deviceId);
  }

  /**
   * Picks a device belonging to this user that can take a message right now.
   *
   * Least-recently-used by heartbeat, which spreads load across a user's phones
   * rather than hammering whichever one happens to be first in the Map. With one
   * phone - the common case - this is simply that phone.
   */
  pickForUser(userId: string): Connection | undefined {
    let best: Connection | undefined;

    for (const connection of this.connections.values()) {
      if (connection.userId !== userId) continue;
      // A socket that has not completed its `register` frame has no gatewayId, so
      // we cannot record which device sent the SMS. Not eligible.
      if (!connection.gatewayId) continue;

      if (!best || connection.lastHeartbeatAt < best.lastHeartbeatAt) {
        best = connection;
      }
    }

    return best;
  }

  listForUser(userId: string): Connection[] {
    return [...this.connections.values()].filter((connection) => connection.userId === userId);
  }

  all(): Connection[] {
    return [...this.connections.values()];
  }

  get size(): number {
    return this.connections.size;
  }

  clear(): void {
    this.connections.clear();
  }
}

export const gatewayRegistry = new GatewayRegistry();
