import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../core/errors.js';
import { type Gateway, GatewayStatus } from '../../domain/gateway.js';
import type { GatewayRepository, RegisterGatewayData, UpdateGatewayData } from '../types.js';

/**
 * In-memory GatewayRepository.
 *
 * Enforces the same invariant MongoDB does: `deviceId` is unique, and
 * `register()` upserts on it rather than inserting blindly.
 */

function clone(gateway: Gateway): Gateway {
  return { ...gateway };
}

export class InMemoryGatewayRepository implements GatewayRepository {
  private readonly byId = new Map<string, Gateway>();
  /** deviceId -> id. Mirrors the unique index MongoDB carries. */
  private readonly deviceIndex = new Map<string, string>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async register(data: RegisterGatewayData): Promise<Gateway> {
    const now = new Date();
    const existingId = this.deviceIndex.get(data.deviceId);
    const existing = existingId ? this.byId.get(existingId) : undefined;

    if (existing) {
      // Re-registration. Refresh the name and whatever telemetry arrived, but do
      // NOT reset createdAt - this device has existed since the day it first
      // connected, and "when did we first see this phone?" must stay answerable.
      const updated: Gateway = {
        ...existing,
        deviceName: data.deviceName,
        ...pickTelemetry(data),
        lastConnectedAt: now,
        lastSeenAt: now,
        updatedAt: now,
      };

      this.byId.set(updated.id, updated);
      return clone(updated);
    }

    const gateway: Gateway = {
      id: randomUUID(),
      deviceId: data.deviceId,
      deviceName: data.deviceName,
      userId: data.userId,
      status: GatewayStatus.OFFLINE,
      batteryLevel: data.batteryLevel ?? null,
      isCharging: data.isCharging ?? null,
      simOperator: data.simOperator ?? null,
      phoneNumber: data.phoneNumber ?? null,
      androidVersion: data.androidVersion ?? null,
      appVersion: data.appVersion ?? null,
      canSendSms: data.canSendSms ?? null,
      sims: data.sims ?? [],
      lastSeenAt: now,
      lastConnectedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.byId.set(gateway.id, gateway);
    this.deviceIndex.set(gateway.deviceId, gateway.id);

    return clone(gateway);
  }

  findById(id: string): Promise<Gateway | null> {
    const gateway = this.byId.get(id);
    return Promise.resolve(gateway ? clone(gateway) : null);
  }

  findByDeviceId(deviceId: string): Promise<Gateway | null> {
    const id = this.deviceIndex.get(deviceId);
    if (!id) return Promise.resolve(null);

    const gateway = this.byId.get(id);
    return Promise.resolve(gateway ? clone(gateway) : null);
  }

  listForUser(userId: string): Promise<Gateway[]> {
    const mine = [...this.byId.values()]
      .filter((gateway) => gateway.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);

    return Promise.resolve(mine);
  }

  // Async so a throw rejects rather than exploding at the call site - see the
  // long note in user.memory.repository.ts.
  // eslint-disable-next-line @typescript-eslint/require-await
  async update(id: string, data: UpdateGatewayData): Promise<Gateway> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new NotFoundError('Gateway');
    }

    const updated: Gateway = {
      ...existing,
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.deviceName !== undefined ? { deviceName: data.deviceName } : {}),
      ...pickTelemetry(data),
      ...(data.lastSeenAt !== undefined ? { lastSeenAt: data.lastSeenAt } : {}),
      ...(data.lastConnectedAt !== undefined ? { lastConnectedAt: data.lastConnectedAt } : {}),
      updatedAt: new Date(),
    };

    this.byId.set(id, updated);
    return clone(updated);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(id: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new NotFoundError('Gateway');
    }

    this.byId.delete(id);
    // Keep the deviceId index in step - a stale entry here would make a later
    // re-registration of the same handset resolve to a record that no longer exists.
    this.deviceIndex.delete(existing.deviceId);
  }

  markAllOffline(): Promise<number> {
    let count = 0;

    for (const [id, gateway] of this.byId) {
      if (gateway.status === GatewayStatus.ONLINE || gateway.status === GatewayStatus.DEGRADED) {
        this.byId.set(id, { ...gateway, status: GatewayStatus.OFFLINE, updatedAt: new Date() });
        count += 1;
      }
    }

    return Promise.resolve(count);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.byId.clear();
    this.deviceIndex.clear();
  }
}

/**
 * Only the telemetry keys the caller actually supplied.
 *
 * Spreading the whole payload would write `undefined` over fields the device did
 * not report this time - so a heartbeat that omits `phoneNumber` would erase the
 * number we learned at registration.
 */
function pickTelemetry(data: Partial<UpdateGatewayData>): Partial<UpdateGatewayData> {
  return {
    ...(data.batteryLevel !== undefined ? { batteryLevel: data.batteryLevel } : {}),
    ...(data.isCharging !== undefined ? { isCharging: data.isCharging } : {}),
    ...(data.simOperator !== undefined ? { simOperator: data.simOperator } : {}),
    ...(data.phoneNumber !== undefined ? { phoneNumber: data.phoneNumber } : {}),
    ...(data.androidVersion !== undefined ? { androidVersion: data.androidVersion } : {}),
    ...(data.appVersion !== undefined ? { appVersion: data.appVersion } : {}),
    ...(data.canSendSms !== undefined ? { canSendSms: data.canSendSms } : {}),
    // The device reports its FULL SIM list every time, so a replace is correct -
    // unlike the scalar fields above, an empty array here is a real value ("no
    // SIMs"), not "unknown". Only skip it when the field is genuinely absent,
    // which is what an old APK that predates multi-SIM sends.
    ...(data.sims !== undefined ? { sims: data.sims } : {}),
  };
}
