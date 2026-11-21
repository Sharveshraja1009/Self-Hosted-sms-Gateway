import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../core/errors.js';
import { type Message, MessageStatus } from '../../domain/message.js';
import type {
  CreateMessageData,
  LineDailyStats,
  MessageQuery,
  MessageRepository,
  Paginated,
  UpdateMessageData,
} from '../types.js';

/** In-memory MessageRepository. */

function clone(message: Message): Message {
  return { ...message };
}

export class InMemoryMessageRepository implements MessageRepository {
  private readonly byId = new Map<string, Message>();

  create(data: CreateMessageData): Promise<Message> {
    const now = new Date();

    const message: Message = {
      id: randomUUID(),
      userId: data.userId,
      gatewayId: null,
      recipient: data.recipient,
      // Unknown until a device is picked - we do not know which SIM will carry it.
      senderNumber: null,
      senderDeviceId: null,
      senderSubscriptionId: null,
      body: data.body,
      status: MessageStatus.QUEUED,
      partCount: data.partCount,
      isUnicode: data.isUnicode,
      attempts: 0,
      triedLines: [],
      pinnedFrom: data.pinnedFrom ?? null,
      errorCode: null,
      errorMessage: null,
      clientRef: data.clientRef,
      queuedAt: now,
      dispatchedAt: null,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.byId.set(message.id, message);
    return Promise.resolve(clone(message));
  }

  findById(id: string): Promise<Message | null> {
    const message = this.byId.get(id);
    return Promise.resolve(message ? clone(message) : null);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(id: string, data: UpdateMessageData): Promise<Message> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new NotFoundError('Message');
    }

    const updated: Message = {
      ...existing,
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.gatewayId !== undefined ? { gatewayId: data.gatewayId } : {}),
      ...(data.senderNumber !== undefined ? { senderNumber: data.senderNumber } : {}),
      ...(data.senderDeviceId !== undefined ? { senderDeviceId: data.senderDeviceId } : {}),
      ...(data.senderSubscriptionId !== undefined ? { senderSubscriptionId: data.senderSubscriptionId } : {}),
      ...(data.triedLines !== undefined ? { triedLines: data.triedLines } : {}),
      ...(data.attempts !== undefined ? { attempts: data.attempts } : {}),
      ...(data.errorCode !== undefined ? { errorCode: data.errorCode } : {}),
      ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
      ...(data.dispatchedAt !== undefined ? { dispatchedAt: data.dispatchedAt } : {}),
      ...(data.sentAt !== undefined ? { sentAt: data.sentAt } : {}),
      ...(data.deliveredAt !== undefined ? { deliveredAt: data.deliveredAt } : {}),
      ...(data.failedAt !== undefined ? { failedAt: data.failedAt } : {}),
      updatedAt: new Date(),
    };

    this.byId.set(id, updated);
    return clone(updated);
  }

  list(query: MessageQuery): Promise<Paginated<Message>> {
    const needle = query.search?.toLowerCase();

    const all = [...this.byId.values()]
      .filter((message) => (query.userId ? message.userId === query.userId : true))
      .filter((message) => (query.status ? message.status === query.status : true))
      .filter((message) =>
        needle
          ? message.recipient.toLowerCase().includes(needle) ||
            message.body.toLowerCase().includes(needle) ||
            (message.senderNumber?.toLowerCase().includes(needle) ?? false)
          : true,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const start = (query.page - 1) * query.limit;

    return Promise.resolve({
      items: all.slice(start, start + query.limit).map(clone),
      total: all.length,
    });
  }

  findQueuedForUser(userId: string, limit: number): Promise<Message[]> {
    // Oldest FIRST here, unlike list(): this is a queue being drained, not a
    // dashboard being read.
    const queued = [...this.byId.values()]
      .filter((message) => message.userId === userId && message.status === MessageStatus.QUEUED)
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())
      .slice(0, limit)
      .map(clone);

    return Promise.resolve(queued);
  }

  dailyLineStats(userId: string | null, from: Date, to: Date): Promise<LineDailyStats[]> {
    const buckets = new Map<string, LineDailyStats>();

    for (const message of this.byId.values()) {
      if (userId && message.userId !== userId) continue;

      // Same rule as Mongo: the day a SIM RADIATED it, and only messages that
      // actually reached a device.
      const at = message.dispatchedAt;
      if (!at || at < from || at >= to) continue;

      const key = `${message.gatewayId}|${message.senderDeviceId}|${message.senderSubscriptionId}|${message.senderNumber}`;

      const bucket = buckets.get(key) ?? {
        gatewayId: message.gatewayId,
        deviceId: message.senderDeviceId,
        subscriptionId: message.senderSubscriptionId,
        senderNumber: message.senderNumber,
        attempted: 0,
        parts: 0,
        sent: 0,
        delivered: 0,
        failed: 0,
        pending: 0,
      };

      bucket.attempted += 1;
      bucket.parts += message.partCount;
      if (message.status === MessageStatus.SENT || message.status === MessageStatus.DELIVERED) bucket.sent += 1;
      if (message.status === MessageStatus.DELIVERED) bucket.delivered += 1;
      if (message.status === MessageStatus.FAILED) bucket.failed += 1;
      bucket.pending = Math.max(0, bucket.attempted - bucket.sent - bucket.failed);

      buckets.set(key, bucket);
    }

    return Promise.resolve([...buckets.values()]);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.byId.clear();
  }
}
