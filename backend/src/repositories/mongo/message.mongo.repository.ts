import { randomUUID } from 'node:crypto';

import type { Collection, Db, Filter, MatchKeysAndValues } from 'mongodb';

import { NotFoundError } from '../../core/errors.js';
import { type Message, MessageStatus } from '../../domain/message.js';
import { Collections } from '../../infra/mongo.js';
import type {
  CreateMessageData,
  LineDailyStats,
  MessageQuery,
  MessageRepository,
  Paginated,
  UpdateMessageData,
} from '../types.js';
import type { MessageDoc } from './documents.js';
import { toDomainMessage } from './mappers.js';

/** Escapes a user string so it is matched literally inside a $regex. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** MongoDB-backed MessageRepository. */
export class MongoMessageRepository implements MessageRepository {
  private readonly messages: Collection<MessageDoc>;

  constructor(db: Db) {
    this.messages = db.collection<MessageDoc>(Collections.MESSAGES);
  }

  async create(data: CreateMessageData): Promise<Message> {
    const now = new Date();

    const doc: MessageDoc = {
      _id: randomUUID(),
      userId: data.userId,
      gatewayId: null,
      recipient: data.recipient,
      // Unknown until a device is picked - we do not yet know which SIM carries it.
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

    await this.messages.insertOne(doc);

    return toDomainMessage(doc);
  }

  async findById(id: string): Promise<Message | null> {
    const doc = await this.messages.findOne({ _id: id });
    return doc ? toDomainMessage(doc) : null;
  }

  async update(id: string, data: UpdateMessageData): Promise<Message> {
    const changes: MatchKeysAndValues<MessageDoc> = {
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

    const doc = await this.messages.findOneAndUpdate({ _id: id }, { $set: changes }, { returnDocument: 'after' });

    if (!doc) {
      throw new NotFoundError('Message');
    }

    return toDomainMessage(doc);
  }

  async list(query: MessageQuery): Promise<Paginated<Message>> {
    const filter: Filter<MessageDoc> = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            // Case-insensitive match across the three fields a human searches by.
            // The search term is escaped so a user typing "+91" or "." is treated
            // as literal text, not a regex - otherwise "." would match everything
            // and "(" would throw.
            $or: [
              { recipient: { $regex: escapeRegex(query.search), $options: 'i' } },
              { senderNumber: { $regex: escapeRegex(query.search), $options: 'i' } },
              { body: { $regex: escapeRegex(query.search), $options: 'i' } },
            ],
          }
        : {}),
    };

    // $facet: the page and the total computed over one view of the collection, so
    // a message arriving between two round-trips cannot make them disagree.
    const [result] = await this.messages
      .aggregate<{ items: MessageDoc[]; total: { value: number }[] }>([
        { $match: filter },
        {
          $facet: {
            items: [{ $sort: { createdAt: -1 } }, { $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
            total: [{ $count: 'value' }],
          },
        },
      ])
      .toArray();

    return {
      items: (result?.items ?? []).map(toDomainMessage),
      total: result?.total[0]?.value ?? 0,
    };
  }

  async findQueuedForUser(userId: string, limit: number): Promise<Message[]> {
    // Oldest first - this is a queue being drained, not a dashboard being read.
    const docs = await this.messages
      .find({ userId, status: MessageStatus.QUEUED })
      .sort({ queuedAt: 1 })
      .limit(limit)
      .toArray();

    return docs.map(toDomainMessage);
  }

  async dailyLineStats(userId: string | null, from: Date, to: Date): Promise<LineDailyStats[]> {
    // dispatchedAt, not createdAt: the cap belongs to the day the SIM actually
    // radiated the message. A message that sat QUEUED overnight is spent against
    // the morning it went out, which is the day the carrier counts it in.
    //
    // A message that never reached a device has no dispatchedAt at all and is
    // therefore excluded - it spent nobody's quota.
    const rows = await this.messages
      .aggregate<{
        _id: {
          gatewayId: string | null;
          deviceId: string | null;
          subscriptionId: number | null;
          senderNumber: string | null;
        };
        attempted: number;
        parts: number;
        sent: number;
        delivered: number;
        failed: number;
      }>([
        { $match: { ...(userId ? { userId } : {}), dispatchedAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: {
              gatewayId: '$gatewayId',
              // $ifNull so pre-upgrade rows (no such key) group under null rather
              // than being silently dropped by the missing-field semantics.
              deviceId: { $ifNull: ['$senderDeviceId', null] },
              subscriptionId: { $ifNull: ['$senderSubscriptionId', null] },
              senderNumber: { $ifNull: ['$senderNumber', null] },
            },
            attempted: { $sum: 1 },
            parts: { $sum: '$partCount' },
            sent: {
              $sum: { $cond: [{ $in: ['$status', [MessageStatus.SENT, MessageStatus.DELIVERED]] }, 1, 0] },
            },
            delivered: { $sum: { $cond: [{ $eq: ['$status', MessageStatus.DELIVERED] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', MessageStatus.FAILED] }, 1, 0] } },
          },
        },
      ])
      .toArray();

    return rows.map((row) => ({
      gatewayId: row._id.gatewayId,
      deviceId: row._id.deviceId,
      subscriptionId: row._id.subscriptionId,
      senderNumber: row._id.senderNumber,
      attempted: row.attempted,
      parts: row.parts,
      sent: row.sent,
      delivered: row.delivered,
      failed: row.failed,
      // Everything with no verdict yet: dispatched, still SENDING (or cancelled
      // mid-flight). Derived rather than counted so the four buckets always sum
      // to `attempted` no matter what statuses exist.
      pending: Math.max(0, row.attempted - row.sent - row.failed),
    }));
  }
}
