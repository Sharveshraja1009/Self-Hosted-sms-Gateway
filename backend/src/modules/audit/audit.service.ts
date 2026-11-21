import type { Request } from 'express';

import { getContext } from '../../core/request-context.js';
import { createLogger } from '../../core/logger.js';
import type { AuditAction } from '../../domain/audit.js';
import { repositories } from '../../repositories/index.js';
import type { AuditLogQuery } from '../../repositories/types.js';

/**
 * Audit trail writer.
 *
 * Two properties make this safe to call from anywhere:
 *
 *  1. **It never throws.** An audit write failing must not turn a successful
 *     login into a 500. We log the failure loudly and let the request proceed.
 *     (With a real database behind it, this matters even more: a network blip on
 *     the audit insert must not fail a login that already succeeded.)
 *
 *  2. **It never persists secrets.** Callers pass `metadata`, and it is on them
 *     not to put a password or token in it - but the shape of the API steers you
 *     away: you pass an email and a reason, not a credential.
 *
 * Every entry is also mirrored to the application log, so an operator tailing
 * stdout sees security events in-line with everything else.
 */

const log = createLogger('audit');

export interface AuditContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** Pulls the request-scoped context an audit entry needs. Safe outside a request. */
export function auditContextFrom(req?: Request): AuditContext {
  return {
    ip: req?.ip ?? null,
    userAgent: req?.get('user-agent') ?? null,
    requestId: req?.id ?? getContext()?.requestId ?? null,
  };
}

export const auditService = {
  async record(params: {
    userId: string | null;
    action: AuditAction;
    status: 'SUCCESS' | 'FAILURE';
    metadata?: Record<string, unknown>;
    context: AuditContext;
  }): Promise<void> {
    try {
      await repositories().auditLogs.create({
        userId: params.userId,
        action: params.action,
        status: params.status,
        metadata: params.metadata ?? {},
        ip: params.context.ip,
        userAgent: params.context.userAgent,
        requestId: params.context.requestId,
      });

      const line = `${params.action} ${params.status}`;
      const payload = { userId: params.userId, ip: params.context.ip, ...params.metadata };

      if (params.status === 'FAILURE') {
        log.warn(line, payload);
      } else {
        log.info(line, payload);
      }
    } catch (error) {
      // Deliberately swallowed: see the contract above.
      log.error('Failed to write audit entry', {
        action: params.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** Convenience wrappers so call sites read like the event they describe. */
  async success(
    action: AuditAction,
    userId: string | null,
    context: AuditContext,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.record({ userId, action, status: 'SUCCESS', metadata, context });
  },

  async failure(
    action: AuditAction,
    userId: string | null,
    context: AuditContext,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.record({ userId, action, status: 'FAILURE', metadata, context });
  },

  async list(query: AuditLogQuery) {
    return repositories().auditLogs.list(query);
  },
};
