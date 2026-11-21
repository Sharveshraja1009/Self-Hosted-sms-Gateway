import type { ApiKey, RefreshToken, Role, User } from '../domain/user.js';
import type { AuditAction, AuditLog, AuditStatus } from '../domain/audit.js';
import type { Campaign, CampaignRecipient, CampaignStatus, PausedBy, RecipientVars } from '../domain/campaign.js';
import type { DeviceTelemetry, Gateway, GatewayStatus } from '../domain/gateway.js';
import type { Message, MessageStatus } from '../domain/message.js';

/**
 * Repository ports.
 *
 * The service layer depends on these interfaces, never on a concrete store. The
 * tests satisfy them with Maps; production satisfies them with MongoDB. Because
 * every method here is already async, that swap changes no call site - the
 * services are written against the shape of the *contract*, not the shape of the
 * database.
 *
 * The rule this enforces: business logic must never know whether a lookup hits
 * RAM or MongoDB.
 */

export interface Paginated<T> {
  items: T[];
  total: number;
}

export interface PageQuery {
  page: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface CreateUserData {
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
  dailySmsLimit: number;
}

export interface UpdateUserData {
  name?: string;
  role?: Role;
  isActive?: boolean;
  dailySmsLimit?: number;
  passwordHash?: string;
  lastLoginAt?: Date;
}

export interface UserRepository {
  create(data: CreateUserData): Promise<User>;
  findById(id: string): Promise<User | null>;
  /** Callers pass any casing; the implementation normalises. */
  findByEmail(email: string): Promise<User | null>;
  update(id: string, data: UpdateUserData): Promise<User>;
  delete(id: string): Promise<void>;
  list(query: PageQuery): Promise<Paginated<User>>;
  count(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export interface CreateRefreshTokenData {
  userId: string;
  tokenHash: string;
  family: string;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export interface RefreshTokenRepository {
  create(data: CreateRefreshTokenData): Promise<RefreshToken>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  /** Rotation: mark the old token spent and point it at its successor. */
  revoke(id: string, replacedByTokenId: string | null): Promise<void>;
  /** Theft response: burn every token descended from the same login. */
  revokeFamily(family: string): Promise<number>;
  /** "Log out everywhere". */
  revokeAllForUser(userId: string): Promise<number>;
  /** Housekeeping - expired rows are dead weight. */
  deleteExpired(now: Date): Promise<number>;
  countActiveForUser(userId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface CreateApiKeyData {
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: ApiKey['scopes'];
  expiresAt: Date | null;
}

export interface ApiKeyRepository {
  create(data: CreateApiKeyData): Promise<ApiKey>;
  /** SHA-256 is deterministic, so we look up by digest directly - no plaintext scan. */
  findByHash(keyHash: string): Promise<ApiKey | null>;
  findById(id: string): Promise<ApiKey | null>;
  listForUser(userId: string): Promise<ApiKey[]>;
  touchLastUsed(id: string, at: Date): Promise<void>;
  revoke(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface CreateAuditLogData {
  userId: string | null;
  action: AuditAction;
  status: AuditStatus;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface AuditLogQuery extends PageQuery {
  userId?: string;
  action?: AuditAction;
  status?: AuditStatus;
}

export interface AuditLogRepository {
  create(data: CreateAuditLogData): Promise<AuditLog>;
  list(query: AuditLogQuery): Promise<Paginated<AuditLog>>;
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

export interface RegisterGatewayData extends Partial<DeviceTelemetry> {
  userId: string;
  deviceId: string;
  deviceName: string;
}

export interface UpdateGatewayData extends Partial<DeviceTelemetry> {
  status?: GatewayStatus;
  deviceName?: string;
  lastSeenAt?: Date;
  lastConnectedAt?: Date;
}

export interface GatewayRepository {
  /**
   * Upsert on `deviceId`.
   *
   * The Android app calls this on every connect, and it must be idempotent: a
   * phone that reconnects 40 times a day because it is on flaky mobile data must
   * not create 40 gateway records. `deviceId` is the natural key - it is stable
   * per install - so it, not our own uuid, is what identity hangs off.
   */
  register(data: RegisterGatewayData): Promise<Gateway>;
  findById(id: string): Promise<Gateway | null>;
  findByDeviceId(deviceId: string): Promise<Gateway | null>;
  listForUser(userId: string): Promise<Gateway[]>;
  update(id: string, data: UpdateGatewayData): Promise<Gateway>;
  /**
   * Remove a device record entirely. Used to clear out a stale registration - e.g.
   * a phone that reinstalled the app under a new deviceId, leaving its old row
   * orphaned. A device that is still connected will simply re-register on its next
   * heartbeat, so callers are expected to refuse deletion while it is live.
   */
  delete(id: string): Promise<void>;
  /**
   * Crash recovery. On boot, every gateway this process believed was ONLINE is
   * now, by definition, not - the sockets died with the old process. Without this
   * the dashboard shows phantom online devices forever and the dispatcher hands
   * messages to sockets that no longer exist.
   */
  markAllOffline(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface CreateMessageData {
  userId: string;
  recipient: string;
  body: string;
  partCount: number;
  isUnicode: boolean;
  clientRef: string | null;
  /** The number this send was pinned to, or null (balanced). Disables SIM failover when set. */
  pinnedFrom?: string | null;
}

export interface UpdateMessageData {
  status?: MessageStatus;
  gatewayId?: string | null;
  /** Stamped at dispatch, once we know which SIM is about to carry it. */
  senderNumber?: string | null;
  /** The line that carried it - `senderNumber` is only a label, this is the identity. */
  senderDeviceId?: string | null;
  senderSubscriptionId?: number | null;
  /** The SIMs tried so far (`deviceId:subscriptionId`), appended on each dispatch. */
  triedLines?: string[];
  attempts?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  dispatchedAt?: Date;
  sentAt?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
}

export interface MessageQuery extends PageQuery {
  userId?: string;
  status?: MessageStatus;
  /** Case-insensitive substring match against recipient, sender number and body. */
  search?: string;
}

export interface MessageRepository {
  create(data: CreateMessageData): Promise<Message>;
  findById(id: string): Promise<Message | null>;
  update(id: string, data: UpdateMessageData): Promise<Message>;
  list(query: MessageQuery): Promise<Paginated<Message>>;
  /**
   * Messages accepted while no device was connected, oldest first.
   *
   * This is the entire "queue" of the thin slice: there is no BullMQ yet, so a
   * message with nowhere to go simply stays QUEUED, and the next device to
   * connect drains it. Oldest-first because a queue that serves the newest
   * message first is not a queue, it is a stack - and the message that has been
   * waiting longest is the one whose sender is most annoyed.
   */
  findQueuedForUser(userId: string, limit: number): Promise<Message[]>;
  /**
   * What each SIM actually did between two instants - the durable answer to "how
   * many has this number sent today?".
   *
   * The in-memory quota counter cannot answer that: it is a safety margin that
   * resets on every restart, so a panel reading it shows 0/100 for a SIM that has
   * sent forty messages since lunch. These rows come from the messages themselves,
   * so they survive restarts and can be asked about any past day.
   *
   * Scoped by DISPATCH time, not creation time: a message accepted at 23:58 and
   * handed to a SIM at 00:02 is spent against the new day's cap, because that is
   * the day the carrier will count it in.
   *
   * A null `userId` means every account. The quota counters need that: they are
   * keyed on the physical line, are rebuilt at boot before anyone has logged in,
   * and a SIM's daily cap is the carrier's, not one tenant's.
   */
  dailyLineStats(userId: string | null, from: Date, to: Date): Promise<LineDailyStats[]>;
}

/**
 * One SIM's traffic for a day.
 *
 * Keyed by the line (`deviceId` + `subscriptionId`) with `gatewayId`/`senderNumber`
 * carried alongside so the caller can still attribute rows written before those
 * fields existed - those have a null subscriptionId and are matched by number.
 */
export interface LineDailyStats {
  gatewayId: string | null;
  deviceId: string | null;
  subscriptionId: number | null;
  senderNumber: string | null;
  /** Dispatched to this SIM at all - the number the daily cap is spent in. */
  attempted: number;
  /** SMS PARTS attempted. What the carrier actually counts, and what the cap is in. */
  parts: number;
  /** Reached SENT or DELIVERED: the radio accepted it. */
  sent: number;
  /** Of those, confirmed DELIVERED by a delivery report. */
  delivered: number;
  failed: number;
  /** Handed to the phone, no verdict yet. */
  pending: number;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface CreateCampaignData {
  userId: string;
  name: string;
  body: string;
  from: string | null;
  intervalMs: number;
  windowStartHour: number;
  windowEndHour: number;
  partCount: number;
  isUnicode: boolean;
  /**
   * Normalised, de-duplicated recipients. Each carries the template variables it
   * was uploaded with - `{name}`, `{amount}`, whatever columns were mapped - and
   * `name` mirrors `vars.name` for display. Both are empty/null for a number that
   * came from the paste box.
   */
  recipients: Array<{ to: string; name: string | null; vars: RecipientVars }>;
}

export interface UpdateCampaignData {
  status?: CampaignStatus;
  /** The whole recipient list, rewritten - the runner mutates one element and saves the array. */
  recipients?: CampaignRecipient[];
  sentCount?: number;
  failedCount?: number;
  pausedReason?: string | null;
  pausedBy?: PausedBy | null;
  lastSendAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface CampaignQuery extends PageQuery {
  userId?: string;
  status?: CampaignStatus;
}

export interface CampaignRepository {
  create(data: CreateCampaignData): Promise<Campaign>;
  findById(id: string): Promise<Campaign | null>;
  update(id: string, data: UpdateCampaignData): Promise<Campaign>;
  list(query: CampaignQuery): Promise<Paginated<Campaign>>;
  /**
   * Every campaign in a given state, across all users. The runner needs this to
   * find RUNNING campaigns to advance - it is a background worker, not a request,
   * so it has no single user to scope to.
   */
  listByStatus(status: CampaignStatus): Promise<Campaign[]>;
}

/** The full set of ports the application needs. Swapping the store replaces the values, not the shape. */
export interface Repositories {
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  apiKeys: ApiKeyRepository;
  auditLogs: AuditLogRepository;
  gateways: GatewayRepository;
  messages: MessageRepository;
  campaigns: CampaignRepository;
}
