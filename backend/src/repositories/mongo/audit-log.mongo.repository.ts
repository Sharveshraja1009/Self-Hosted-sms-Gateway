import { randomUUID } from 'node:crypto';

import type { Collection, Db, Filter } from 'mongodb';

import type { AuditLog } from '../../domain/audit.js';
import { Collections } from '../../infra/mongo.js';
import type { AuditLogQuery, AuditLogRepository, CreateAuditLogData, Paginated } from '../types.js';
import type { AuditLogDoc } from './documents.js';
import { toDomainAuditLog } from './mappers.js';

/**
 * MongoDB-backed AuditLogRepository.
 *
 * Append-only, enforced by the port: there is no `update` and no `delete` here,
 * so no amount of future code can rewrite the security history. The only way to
 * remove an entry is to open a Mongo shell and do it by hand, which is exactly
 * the friction we want in front of that action.
 */
export class MongoAuditLogRepository implements AuditLogRepository {
  private readonly logs: Collection<AuditLogDoc>;

  constructor(db: Db) {
    this.logs = db.collection<AuditLogDoc>(Collections.AUDIT_LOGS);
  }

  async create(data: CreateAuditLogData): Promise<AuditLog> {
    const doc: AuditLogDoc = {
      _id: randomUUID(),
      userId: data.userId,
      action: data.action,
      status: data.status,
      metadata: data.metadata,
      ip: data.ip,
      userAgent: data.userAgent,
      requestId: data.requestId,
      createdAt: new Date(),
    };

    await this.logs.insertOne(doc);

    return toDomainAuditLog(doc);
  }

  async list(query: AuditLogQuery): Promise<Paginated<AuditLog>> {
    const filter: Filter<AuditLogDoc> = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    // One $facet rather than a find() plus a countDocuments(): the page and the
    // total are computed over the same view of the collection, so they cannot
    // disagree because an entry landed between two round-trips. The audit log is
    // append-heavy, so that race is not hypothetical - it is every busy minute.
    const [result] = await this.logs
      .aggregate<{ items: AuditLogDoc[]; total: { value: number }[] }>([
        { $match: filter },
        {
          $facet: {
            items: [
              // Newest first: what an operator wants when something just broke.
              { $sort: { createdAt: -1 } },
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
            ],
            total: [{ $count: 'value' }],
          },
        },
      ])
      .toArray();

    return {
      items: (result?.items ?? []).map(toDomainAuditLog),
      total: result?.total[0]?.value ?? 0,
    };
  }
}
