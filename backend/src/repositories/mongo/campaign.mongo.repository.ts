import { randomUUID } from 'node:crypto';

import type { Collection, Db, Filter, MatchKeysAndValues } from 'mongodb';

import { NotFoundError } from '../../core/errors.js';
import { type Campaign, CampaignStatus, RecipientStatus } from '../../domain/campaign.js';
import { Collections } from '../../infra/mongo.js';
import type { CampaignQuery, CampaignRepository, CreateCampaignData, Paginated, UpdateCampaignData } from '../types.js';
import type { CampaignDoc } from './documents.js';
import { toDomainCampaign } from './mappers.js';

/** MongoDB-backed CampaignRepository. */
export class MongoCampaignRepository implements CampaignRepository {
  private readonly campaigns: Collection<CampaignDoc>;

  constructor(db: Db) {
    this.campaigns = db.collection<CampaignDoc>(Collections.CAMPAIGNS);
  }

  async create(data: CreateCampaignData): Promise<Campaign> {
    const now = new Date();

    const doc: CampaignDoc = {
      _id: randomUUID(),
      userId: data.userId,
      name: data.name,
      body: data.body,
      from: data.from,
      intervalMs: data.intervalMs,
      windowStartHour: data.windowStartHour,
      windowEndHour: data.windowEndHour,
      status: CampaignStatus.DRAFT,
      recipients: data.recipients.map(({ to, name, vars }) => ({
        to,
        name,
        vars,
        status: RecipientStatus.PENDING,
        messageId: null,
        error: null,
        sentAt: null,
      })),
      partCount: data.partCount,
      isUnicode: data.isUnicode,
      sentCount: 0,
      failedCount: 0,
      pausedReason: null,
      pausedBy: null,
      lastSendAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.campaigns.insertOne(doc);

    return toDomainCampaign(doc);
  }

  async findById(id: string): Promise<Campaign | null> {
    const doc = await this.campaigns.findOne({ _id: id });
    return doc ? toDomainCampaign(doc) : null;
  }

  async update(id: string, data: UpdateCampaignData): Promise<Campaign> {
    const changes: MatchKeysAndValues<CampaignDoc> = {
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.recipients !== undefined ? { recipients: data.recipients } : {}),
      ...(data.sentCount !== undefined ? { sentCount: data.sentCount } : {}),
      ...(data.failedCount !== undefined ? { failedCount: data.failedCount } : {}),
      ...(data.pausedReason !== undefined ? { pausedReason: data.pausedReason } : {}),
      ...(data.pausedBy !== undefined ? { pausedBy: data.pausedBy } : {}),
      ...(data.lastSendAt !== undefined ? { lastSendAt: data.lastSendAt } : {}),
      ...(data.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
      ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      updatedAt: new Date(),
    };

    const doc = await this.campaigns.findOneAndUpdate({ _id: id }, { $set: changes }, { returnDocument: 'after' });

    if (!doc) {
      throw new NotFoundError('Campaign');
    }

    return toDomainCampaign(doc);
  }

  async list(query: CampaignQuery): Promise<Paginated<Campaign>> {
    const filter: Filter<CampaignDoc> = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [result] = await this.campaigns
      .aggregate<{ items: CampaignDoc[]; total: { value: number }[] }>([
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
      items: (result?.items ?? []).map(toDomainCampaign),
      total: result?.total[0]?.value ?? 0,
    };
  }

  async listByStatus(status: CampaignStatus): Promise<Campaign[]> {
    const docs = await this.campaigns.find({ status }).sort({ createdAt: 1 }).toArray();
    return docs.map(toDomainCampaign);
  }
}
