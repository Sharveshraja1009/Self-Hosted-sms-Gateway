import type { AuditLog } from '../../domain/audit.js';
import type { Campaign } from '../../domain/campaign.js';
import type { Gateway } from '../../domain/gateway.js';
import type { Message } from '../../domain/message.js';
import type { ApiKey, RefreshToken, User } from '../../domain/user.js';
import type {
  ApiKeyDoc,
  AuditLogDoc,
  CampaignDoc,
  GatewayDoc,
  MessageDoc,
  RefreshTokenDoc,
  UserDoc,
} from './documents.js';

/**
 * The anti-corruption layer between stored documents and domain entities.
 *
 * It would be tempting to declare the document types *as* the domain types and
 * delete this file. Two reasons not to:
 *
 *  1. The storage shape has `_id`; the domain has `id`. Leaking `_id` upwards
 *     would put a MongoDB spelling into every service, controller and JSON
 *     response - and the next store swap would then be a rewrite rather than a
 *     new folder. This tiny rename is what keeps that door open.
 *
 *  2. A document read back from Mongo is `WithId<T>`, whose fields the driver
 *     cannot guarantee at compile time (an old document written by an earlier
 *     version of the code is still just BSON). Funnelling every read through one
 *     function gives us exactly one place to defend that boundary.
 */

export function toDomainUser(doc: UserDoc): User {
  return {
    id: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    name: doc.name,
    role: doc.role,
    isActive: doc.isActive,
    dailySmsLimit: doc.dailySmsLimit,
    lastLoginAt: doc.lastLoginAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function toDomainRefreshToken(doc: RefreshTokenDoc): RefreshToken {
  return {
    id: doc._id,
    userId: doc.userId,
    tokenHash: doc.tokenHash,
    family: doc.family,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
    revokedAt: doc.revokedAt,
    replacedByTokenId: doc.replacedByTokenId,
    userAgent: doc.userAgent,
    ip: doc.ip,
  };
}

export function toDomainApiKey(doc: ApiKeyDoc): ApiKey {
  return {
    id: doc._id,
    userId: doc.userId,
    name: doc.name,
    keyHash: doc.keyHash,
    keyPrefix: doc.keyPrefix,
    // Defensive copy: the caller must not be able to mutate an array that the
    // driver may still hold a reference to.
    scopes: [...doc.scopes],
    isActive: doc.isActive,
    expiresAt: doc.expiresAt,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
    revokedAt: doc.revokedAt,
  };
}

export function toDomainAuditLog(doc: AuditLogDoc): AuditLog {
  return {
    id: doc._id,
    userId: doc.userId,
    action: doc.action,
    status: doc.status,
    metadata: doc.metadata,
    ip: doc.ip,
    userAgent: doc.userAgent,
    requestId: doc.requestId,
    createdAt: doc.createdAt,
  };
}

/**
 * `?? null` on every telemetry field, deliberately.
 *
 * A gateway inserted by `$setOnInsert` before its first heartbeat has no
 * `batteryLevel` key at all. The domain promises `number | null`, so absence must
 * become an explicit null here - otherwise `undefined` leaks out, `JSON.stringify`
 * silently *drops the key* from the API response, and the dashboard renders a
 * blank cell it has no way to explain.
 */
export function toDomainGateway(doc: GatewayDoc): Gateway {
  return {
    id: doc._id,
    deviceId: doc.deviceId,
    deviceName: doc.deviceName,
    userId: doc.userId,
    status: doc.status,
    batteryLevel: doc.batteryLevel ?? null,
    isCharging: doc.isCharging ?? null,
    simOperator: doc.simOperator ?? null,
    phoneNumber: doc.phoneNumber ?? null,
    androidVersion: doc.androidVersion ?? null,
    appVersion: doc.appVersion ?? null,
    canSendSms: doc.canSendSms ?? null,
    // `?? []`: a document from before multi-SIM has no `sims` key, and the domain
    // promises an array. linesOf() then synthesises a single line from phoneNumber.
    sims: doc.sims ?? [],
    lastSeenAt: doc.lastSeenAt ?? null,
    lastConnectedAt: doc.lastConnectedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function toDomainCampaign(doc: CampaignDoc): Campaign {
  return {
    id: doc._id,
    userId: doc.userId,
    name: doc.name,
    body: doc.body,
    from: doc.from,
    intervalMs: doc.intervalMs,
    // Default a pre-window campaign to a 24h window, so it behaves exactly as it
    // did before the feature existed rather than suddenly refusing to send.
    windowStartHour: doc.windowStartHour ?? 0,
    windowEndHour: doc.windowEndHour ?? 24,
    status: doc.status,
    // Defensive copy of the embedded array, and of each element - the driver may
    // still hold a reference to what it decoded. `name` defaults to null so a
    // campaign stored before {name} personalisation existed still maps cleanly, and
    // `vars` is rebuilt from that name for campaigns stored before variables
    // existed - so an old campaign resumed today renders {name} exactly as it did.
    recipients: (doc.recipients ?? []).map((r) => ({
      ...r,
      name: r.name ?? null,
      vars: r.vars ?? (r.name ? { name: r.name } : {}),
    })),
    partCount: doc.partCount,
    isUnicode: doc.isUnicode,
    sentCount: doc.sentCount,
    failedCount: doc.failedCount,
    pausedReason: doc.pausedReason ?? null,
    // A campaign paused by the old code has no pausedBy. Defaulting to null (not
    // SYSTEM) means auto-resume ignores it: a pause whose origin we cannot know
    // must not be undone on our guess.
    pausedBy: doc.pausedBy ?? null,
    lastSendAt: doc.lastSendAt ?? null,
    startedAt: doc.startedAt ?? null,
    completedAt: doc.completedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function toDomainMessage(doc: MessageDoc): Message {
  return {
    id: doc._id,
    userId: doc.userId,
    gatewayId: doc.gatewayId,
    recipient: doc.recipient,
    // `?? null`: documents written before senderNumber existed have no such key,
    // and undefined would be silently dropped by JSON.stringify.
    senderNumber: doc.senderNumber ?? null,
    senderDeviceId: doc.senderDeviceId ?? null,
    senderSubscriptionId: doc.senderSubscriptionId ?? null,
    body: doc.body,
    status: doc.status,
    partCount: doc.partCount,
    isUnicode: doc.isUnicode,
    attempts: doc.attempts,
    // `?? []` / `?? null`: pre-failover documents have no such key, and undefined
    // would leak through JSON.stringify.
    triedLines: doc.triedLines ?? [],
    pinnedFrom: doc.pinnedFrom ?? null,
    errorCode: doc.errorCode,
    errorMessage: doc.errorMessage,
    clientRef: doc.clientRef,
    queuedAt: doc.queuedAt,
    dispatchedAt: doc.dispatchedAt,
    sentAt: doc.sentAt,
    deliveredAt: doc.deliveredAt,
    failedAt: doc.failedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
