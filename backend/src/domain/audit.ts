/**
 * The audit trail.
 *
 * Distinct from application logs on purpose. Logs are for engineers debugging
 * behaviour and are allowed to be noisy, sampled and eventually rotated away.
 * The audit trail answers "who did what, from where, and did it work?" - it is
 * queryable, retained, and surfaced in the dashboard. When a customer asks why
 * 400 messages went out at 2am, this is the table that answers.
 */

export const AuditAction = {
  // --- Identity ------------------------------------------------------------
  USER_REGISTERED: 'USER_REGISTERED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  /** A revoked refresh token was presented again - probable theft. */
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  ACCESS_DENIED: 'ACCESS_DENIED',

  // --- API keys ------------------------------------------------------------
  API_KEY_CREATED: 'API_KEY_CREATED',
  API_KEY_REVOKED: 'API_KEY_REVOKED',
  API_KEY_AUTH_FAILED: 'API_KEY_AUTH_FAILED',

  // --- Gateways (Phase 5) --------------------------------------------------
  GATEWAY_REGISTERED: 'GATEWAY_REGISTERED',
  GATEWAY_CONNECTED: 'GATEWAY_CONNECTED',
  GATEWAY_DISCONNECTED: 'GATEWAY_DISCONNECTED',

  // --- Messages (Phase 4) --------------------------------------------------
  SMS_QUEUED: 'SMS_QUEUED',
  SMS_SENT: 'SMS_SENT',
  SMS_DELIVERED: 'SMS_DELIVERED',
  SMS_FAILED: 'SMS_FAILED',
  SMS_CANCELLED: 'SMS_CANCELLED',
  DAILY_LIMIT_REACHED: 'DAILY_LIMIT_REACHED',
  OTP_SENT: 'OTP_SENT',
  OTP_VERIFIED: 'OTP_VERIFIED',
  OTP_FAILED: 'OTP_FAILED',

  // --- Administration ------------------------------------------------------
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export type AuditStatus = 'SUCCESS' | 'FAILURE';

export interface AuditLog {
  id: string;
  /** Null for anonymous events - a failed login against an unknown email, say. */
  userId: string | null;
  action: AuditAction;
  status: AuditStatus;
  /** Free-form context. MUST NOT contain secrets: no passwords, no tokens, no API keys. */
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: Date;
}

export interface PublicAuditLog {
  id: string;
  userId: string | null;
  action: AuditAction;
  status: AuditStatus;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export function toPublicAuditLog(entry: AuditLog): PublicAuditLog {
  return {
    id: entry.id,
    userId: entry.userId,
    action: entry.action,
    status: entry.status,
    metadata: entry.metadata,
    ip: entry.ip,
    createdAt: entry.createdAt.toISOString(),
  };
}
