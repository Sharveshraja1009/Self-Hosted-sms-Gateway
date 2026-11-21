import { randomUUID } from 'node:crypto';

import type { AuditLog } from '../../domain/audit.js';
import type { AuditLogQuery, AuditLogRepository, CreateAuditLogData, Paginated } from '../types.js';

/**
 * In-memory AuditLogRepository.
 *
 * Append-only by construction: there is no update and no delete on the port, so
 * neither this implementation nor the MongoDB one can offer a way to rewrite
 * history. That is the whole point of an audit trail.
 *
 * The ring buffer only exists because RAM is finite; MongoDB keeps everything.
 */
const MAX_ENTRIES = 10_000;

/** A free function, not a static method: safe to pass straight to `.map()`. */
function clone(entry: AuditLog): AuditLog {
  return { ...entry, metadata: { ...entry.metadata } };
}

export class InMemoryAuditLogRepository implements AuditLogRepository {
  /** Newest last, like a real table ordered by createdAt. */
  private entries: AuditLog[] = [];

  create(data: CreateAuditLogData): Promise<AuditLog> {
    const entry: AuditLog = {
      id: randomUUID(),
      userId: data.userId,
      action: data.action,
      status: data.status,
      metadata: { ...data.metadata },
      ip: data.ip,
      userAgent: data.userAgent,
      requestId: data.requestId,
      createdAt: new Date(),
    };

    this.entries.push(entry);

    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }

    return Promise.resolve(clone(entry));
  }

  list(query: AuditLogQuery): Promise<Paginated<AuditLog>> {
    const filtered = this.entries
      .filter((entry) => {
        if (query.userId && entry.userId !== query.userId) return false;
        if (query.action && entry.action !== query.action) return false;
        if (query.status && entry.status !== query.status) return false;
        return true;
      })
      // Newest first: what an operator wants to see when something just broke.
      .reverse();

    const start = (query.page - 1) * query.limit;

    return Promise.resolve({
      items: filtered.slice(start, start + query.limit).map(clone),
      total: filtered.length,
    });
  }

  clear(): void {
    this.entries = [];
  }
}
