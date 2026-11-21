import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../core/errors.js';
import { type Campaign, CampaignStatus, RecipientStatus } from '../../domain/campaign.js';
import type { CampaignQuery, CampaignRepository, CreateCampaignData, Paginated, UpdateCampaignData } from '../types.js';

/** In-memory CampaignRepository. */

/** Deep clone: recipients is a nested array of objects the caller must not be able to mutate in place. */
function clone(campaign: Campaign): Campaign {
  return { ...campaign, recipients: campaign.recipients.map((r) => ({ ...r, vars: { ...r.vars } })) };
}

export class InMemoryCampaignRepository implements CampaignRepository {
  private readonly byId = new Map<string, Campaign>();

  create(data: CreateCampaignData): Promise<Campaign> {
    const now = new Date();

    const campaign: Campaign = {
      id: randomUUID(),
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

    this.byId.set(campaign.id, campaign);
    return Promise.resolve(clone(campaign));
  }

  findById(id: string): Promise<Campaign | null> {
    const campaign = this.byId.get(id);
    return Promise.resolve(campaign ? clone(campaign) : null);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(id: string, data: UpdateCampaignData): Promise<Campaign> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new NotFoundError('Campaign');
    }

    const updated: Campaign = {
      ...existing,
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.recipients !== undefined
        ? { recipients: data.recipients.map((r) => ({ ...r, vars: { ...r.vars } })) }
        : {}),
      ...(data.sentCount !== undefined ? { sentCount: data.sentCount } : {}),
      ...(data.failedCount !== undefined ? { failedCount: data.failedCount } : {}),
      ...(data.pausedReason !== undefined ? { pausedReason: data.pausedReason } : {}),
      ...(data.pausedBy !== undefined ? { pausedBy: data.pausedBy } : {}),
      ...(data.lastSendAt !== undefined ? { lastSendAt: data.lastSendAt } : {}),
      ...(data.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
      ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      updatedAt: new Date(),
    };

    this.byId.set(id, updated);
    return clone(updated);
  }

  list(query: CampaignQuery): Promise<Paginated<Campaign>> {
    const all = [...this.byId.values()]
      .filter((c) => (query.userId ? c.userId === query.userId : true))
      .filter((c) => (query.status ? c.status === query.status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const start = (query.page - 1) * query.limit;

    return Promise.resolve({
      items: all.slice(start, start + query.limit).map(clone),
      total: all.length,
    });
  }

  listByStatus(status: CampaignStatus): Promise<Campaign[]> {
    // Oldest first - if two campaigns are both due, the one started earlier goes
    // first, which is the least surprising order.
    const matches = [...this.byId.values()]
      .filter((c) => c.status === status)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);

    return Promise.resolve(matches);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.byId.clear();
  }
}
