import type { ApiKeyScope, Role } from '../../domain/user.js';
import type { AuditAction, AuditStatus } from '../../domain/audit.js';
import type { CampaignRecipient, CampaignStatus, PausedBy, RecipientVars } from '../../domain/campaign.js';
import type { GatewayStatus, SimLine } from '../../domain/gateway.js';
import type { MessageStatus } from '../../domain/message.js';

/**
 * The stored shape of every document, and the one deliberate decision this file
 * encodes: **`_id` is a UUID string, not an ObjectId.**
 *
 * The obvious Mongo default would be an ObjectId. We do not use one, because the
 * domain already declares `id: string` and the in-memory store already mints
 * `randomUUID()`. If Mongo minted ObjectIds instead, then `User.id` would be a
 * 24-char hex string under one store and a 36-char UUID under the other - and
 * the whole claim of this architecture ("business logic cannot tell which store
 * is underneath") would quietly become false. The contract suite asserts the
 * UUID shape precisely so that this cannot drift.
 *
 * The cost is 36 bytes per `_id` instead of 12. In exchange, ids are generated
 * by the application rather than the database, which means a caller can know a
 * record's id before the write lands - and the two stores stay honestly
 * interchangeable. That is the trade this project wants.
 *
 * These types are the *storage* shapes. They never leave the repository layer;
 * mappers.ts translates them into the domain types the services speak.
 */

export interface UserDoc {
  _id: string;
  /** Always stored lowercased and trimmed. The unique index is on this field. */
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
  isActive: boolean;
  dailySmsLimit: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshTokenDoc {
  _id: string;
  userId: string;
  /** SHA-256 digest. The plaintext token is never stored. */
  tokenHash: string;
  /** All tokens descended from one login share a family. See auth.service.ts. */
  family: string;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  userAgent: string | null;
  ip: string | null;
}

export interface ApiKeyDoc {
  _id: string;
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  isActive: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AuditLogDoc {
  _id: string;
  userId: string | null;
  action: AuditAction;
  status: AuditStatus;
  /**
   * Stored as a subdocument rather than a serialised JSON string, so the audit
   * view can filter on it later ("every LOGIN_FAILED with reason=bad_password").
   * MUST NOT contain secrets - no passwords, no tokens, no API keys.
   */
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: Date;
}

/**
 * Telemetry fields are optional here, not `| null`, and that is the one place the
 * document type honestly diverges from the domain type.
 *
 * `register()` upserts with `$setOnInsert`, and a device that reports no battery
 * level simply has no `batteryLevel` key in the inserted document - Mongo does
 * not write a null for a field you never mention. The mapper coerces the absence
 * back to `null`, which is what the domain promises. Declaring these `| null`
 * here would be a lie that only surfaces as `undefined` leaking into an API
 * response.
 */
export interface GatewayDoc {
  _id: string;
  deviceId: string;
  deviceName: string;
  userId: string;
  status: GatewayStatus;

  batteryLevel?: number | null;
  isCharging?: boolean | null;
  simOperator?: string | null;
  phoneNumber?: string | null;
  androidVersion?: string | null;
  appVersion?: string | null;
  canSendSms?: boolean | null;

  /** Every SIM in the handset. Absent for a document written by a pre-multi-SIM APK. */
  sims?: SimLine[];

  lastSeenAt?: Date | null;
  lastConnectedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A recipient as STORED. `vars` is optional here and required in the domain,
 * because every campaign written before multi-variable templates existed has no
 * such key - the mapper defaults it rather than the reader guessing.
 */
export type StoredCampaignRecipient = Omit<CampaignRecipient, 'vars'> & { vars?: RecipientVars };

export interface CampaignDoc {
  _id: string;
  userId: string;
  name: string;
  body: string;
  from: string | null;
  intervalMs: number;
  /** Optional in storage: a campaign created before the sending window existed has no such key; the mapper defaults it. */
  windowStartHour?: number;
  windowEndHour?: number;
  status: CampaignStatus;
  /** Embedded, not a separate collection: a campaign is read and written whole, and at ~hundreds of numbers it fits comfortably in one document. */
  recipients: StoredCampaignRecipient[];
  partCount: number;
  isUnicode: boolean;
  sentCount: number;
  failedCount: number;
  pausedReason: string | null;
  /** Optional in storage: a campaign paused before auto-resume existed has no such key; the mapper defaults it. */
  pausedBy?: PausedBy | null;
  lastSendAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDoc {
  _id: string;
  userId: string;
  gatewayId: string | null;
  recipient: string;
  /**
   * Optional, not `| null`: messages written before this field existed simply do
   * not have the key. The mapper coerces the absence to null - see the note on
   * GatewayDoc's telemetry.
   */
  senderNumber?: string | null;
  /**
   * The line that carried it, stamped at dispatch. Optional for the same reason as
   * senderNumber: rows written before per-SIM daily counters existed have no key,
   * and the daily-stats aggregation falls back to (gatewayId, senderNumber) for
   * those rather than dropping them.
   */
  senderDeviceId?: string | null;
  senderSubscriptionId?: number | null;
  body: string;
  status: MessageStatus;
  partCount: number;
  isUnicode: boolean;
  attempts: number;
  /** Absent on documents written before SIM failover existed; the mapper defaults it to []. */
  triedLines?: string[];
  /** Absent on pre-failover documents; the mapper defaults it to null. */
  pinnedFrom?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  clientRef: string | null;
  queuedAt: Date;
  dispatchedAt: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
