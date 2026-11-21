import { randomUUID } from 'node:crypto';

import type { Collection, Db, MatchKeysAndValues } from 'mongodb';

import { NotFoundError } from '../../core/errors.js';
import { type Gateway, GatewayStatus } from '../../domain/gateway.js';
import { Collections } from '../../infra/mongo.js';
import type { GatewayRepository, RegisterGatewayData, UpdateGatewayData } from '../types.js';
import type { GatewayDoc } from './documents.js';
import { toDomainGateway } from './mappers.js';

/**
 * MongoDB-backed GatewayRepository.
 *
 * `register()` is an upsert keyed on `deviceId`, in a single atomic operation
 * rather than a find-then-branch. A phone on flaky mobile data reconnects dozens
 * of times a day, and two of those reconnects racing must not produce two gateway
 * records for one handset. The unique index on `deviceId` is the arbiter, exactly
 * as it is for `users.email`.
 */
export class MongoGatewayRepository implements GatewayRepository {
  private readonly gateways: Collection<GatewayDoc>;

  constructor(db: Db) {
    this.gateways = db.collection<GatewayDoc>(Collections.GATEWAYS);
  }

  async register(data: RegisterGatewayData): Promise<Gateway> {
    const now = new Date();

    const doc = await this.gateways.findOneAndUpdate(
      { deviceId: data.deviceId },
      {
        // $set: things a reconnect legitimately refreshes.
        $set: {
          deviceName: data.deviceName,
          ...telemetryPatch(data),
          lastConnectedAt: now,
          lastSeenAt: now,
          updatedAt: now,
        },
        // $setOnInsert: identity. `createdAt` must answer "when did we FIRST see
        // this phone?", so a reconnect three months later must not reset it. And
        // `userId` is fixed at first registration - a device does not change hands
        // by reconnecting with someone else's key.
        $setOnInsert: {
          _id: randomUUID(),
          deviceId: data.deviceId,
          userId: data.userId,
          status: GatewayStatus.OFFLINE,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    if (!doc) {
      // Unreachable with upsert + returnDocument:'after', but the driver's types
      // permit null and a silent `!` here would be a lie.
      throw new Error(`Gateway upsert returned nothing for device ${data.deviceId}`);
    }

    return toDomainGateway(doc);
  }

  async findById(id: string): Promise<Gateway | null> {
    const doc = await this.gateways.findOne({ _id: id });
    return doc ? toDomainGateway(doc) : null;
  }

  async findByDeviceId(deviceId: string): Promise<Gateway | null> {
    const doc = await this.gateways.findOne({ deviceId });
    return doc ? toDomainGateway(doc) : null;
  }

  async listForUser(userId: string): Promise<Gateway[]> {
    const docs = await this.gateways.find({ userId }).sort({ createdAt: -1 }).toArray();
    return docs.map(toDomainGateway);
  }

  async update(id: string, data: UpdateGatewayData): Promise<Gateway> {
    const changes: MatchKeysAndValues<GatewayDoc> = {
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.deviceName !== undefined ? { deviceName: data.deviceName } : {}),
      ...telemetryPatch(data),
      ...(data.lastSeenAt !== undefined ? { lastSeenAt: data.lastSeenAt } : {}),
      ...(data.lastConnectedAt !== undefined ? { lastConnectedAt: data.lastConnectedAt } : {}),
      updatedAt: new Date(),
    };

    const doc = await this.gateways.findOneAndUpdate({ _id: id }, { $set: changes }, { returnDocument: 'after' });

    if (!doc) {
      throw new NotFoundError('Gateway');
    }

    return toDomainGateway(doc);
  }

  async delete(id: string): Promise<void> {
    const result = await this.gateways.deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      throw new NotFoundError('Gateway');
    }
  }

  async markAllOffline(): Promise<number> {
    const result = await this.gateways.updateMany(
      { status: { $in: [GatewayStatus.ONLINE, GatewayStatus.DEGRADED] } },
      { $set: { status: GatewayStatus.OFFLINE, updatedAt: new Date() } },
    );

    return result.modifiedCount;
  }
}

/**
 * Only the telemetry keys the caller actually supplied.
 *
 * Spreading the payload wholesale would write `undefined` into Mongo as a literal
 * null - so a heartbeat that omits `phoneNumber` would erase the number we
 * learned at registration.
 */
function telemetryPatch(data: Partial<UpdateGatewayData>): MatchKeysAndValues<GatewayDoc> {
  return {
    ...(data.batteryLevel !== undefined ? { batteryLevel: data.batteryLevel } : {}),
    ...(data.isCharging !== undefined ? { isCharging: data.isCharging } : {}),
    ...(data.simOperator !== undefined ? { simOperator: data.simOperator } : {}),
    ...(data.phoneNumber !== undefined ? { phoneNumber: data.phoneNumber } : {}),
    ...(data.androidVersion !== undefined ? { androidVersion: data.androidVersion } : {}),
    ...(data.appVersion !== undefined ? { appVersion: data.appVersion } : {}),
    ...(data.canSendSms !== undefined ? { canSendSms: data.canSendSms } : {}),
    // Full-array replace: the device sends its complete SIM list every time, so
    // an empty array is a real value, not "unknown". Absent only for an old APK.
    ...(data.sims !== undefined ? { sims: data.sims } : {}),
  };
}
