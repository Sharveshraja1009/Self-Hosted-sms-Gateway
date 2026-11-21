/**
 * Campaigns - sending one message to many numbers, one at a time, on a timer.
 *
 * This is the bulk / promotional path. It sits *on top of* the ordinary send
 * path rather than beside it: a campaign does not invent a new way to reach the
 * radio, it just calls `smsService.send()` once per recipient, paced by a delay,
 * from a chosen SIM. Every recipient therefore becomes a normal Message row and
 * shows up in the message history with its own sender/recipient/status.
 *
 * The pacing is not cosmetic. A personal SIM that fires a hundred texts at
 * strangers in ten seconds is the textbook signature a carrier's spam filter
 * blocks for - so the interval between sends, together with the per-SIM daily cap
 * enforced by the router, is what keeps the numbers alive. Weakening either is
 * how you lose a SIM.
 */

import { segment } from './message.js';

export const CampaignStatus = {
  /** Created but never started. */
  DRAFT: 'DRAFT',
  /** Actively sending: the runner advances one recipient per interval. */
  RUNNING: 'RUNNING',
  /**
   * Stopped, but resumable. Either the operator paused it, or the runner hit a
   * recoverable blocker (no phone connected, or every SIM at its daily cap) and
   * parked it rather than burning through the list. `pausedReason` says which.
   */
  PAUSED: 'PAUSED',
  /** Every recipient has been processed. Terminal. */
  COMPLETED: 'COMPLETED',
  /** Abandoned by the operator. Terminal. */
  CANCELLED: 'CANCELLED',
} as const;

export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];

/** Nothing further happens to a campaign in one of these. */
export const TERMINAL_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  CampaignStatus.COMPLETED,
  CampaignStatus.CANCELLED,
];

export const RecipientStatus = {
  /** Not yet attempted. */
  PENDING: 'PENDING',
  /** Handed to a phone (the message was dispatched). Its delivery lives on the Message. */
  SENT: 'SENT',
  /** Permanently failed for this one number. The rest of the campaign carries on. */
  FAILED: 'FAILED',
} as const;

export type RecipientStatus = (typeof RecipientStatus)[keyof typeof RecipientStatus];

/**
 * Who parked a campaign - and therefore who is allowed to un-park it.
 *
 * The distinction exists because the two pauses mean opposite things. SYSTEM is
 * "the runner hit a wall that time clears by itself": no phone was connected, or
 * every SIM had spent its daily cap. Both of those un-block on their own - a phone
 * reconnects, local midnight resets the counters - so leaving the campaign parked
 * until a human notices wastes a day of quota it can never get back. A 50,000-name
 * list runs for a month; a single overnight outage that nobody sees until 10am is
 * a real, permanent loss.
 *
 * OPERATOR is "a person decided to stop", and no amount of clearing weather may
 * override that. The runner never touches an OPERATOR pause, which is the whole
 * reason this field exists rather than the runner just pattern-matching on
 * `pausedReason` text.
 */
export const PausedBy = {
  /** The runner parked it on a blocker that clears with time. Auto-resumable. */
  SYSTEM: 'SYSTEM',
  /** A human pressed pause. Only a human may start it again. */
  OPERATOR: 'OPERATOR',
} as const;

export type PausedBy = (typeof PausedBy)[keyof typeof PausedBy];

export interface CampaignRecipient {
  /** Normalised E.164, e.g. +919876543210. */
  to: string;
  /**
   * The recipient's name, for `{name}` personalisation in the body. Null when the
   * number arrived without one (a bare paste, or a file with no name column) - the
   * runner then substitutes {@link DEFAULT_NAME_FALLBACK} so the message still reads.
   *
   * Kept alongside {@link vars} (where it also lives, under the `name` key) because
   * it is the one variable the panel displays next to the number, and because every
   * campaign stored before multi-variable templates existed has only this field.
   */
  name: string | null;
  /**
   * Every template variable for this recipient, keyed by normalised placeholder
   * name - one entry per mapped spreadsheet column. `{amount}` in the body reads
   * `vars.amount` here. Empty for a number that arrived from the paste box.
   */
  vars: RecipientVars;
  status: RecipientStatus;
  /** The Message this recipient produced once sent, so history can be cross-referenced. */
  messageId: string | null;
  /** Why this recipient failed, if it did. */
  error: string | null;
  sentAt: Date | null;
}

export interface Campaign {
  id: string;
  userId: string;
  name: string;
  body: string;

  /** Pin the sending SIM (E.164), or null to let the router balance across SIMs. */
  from: string | null;

  /** Milliseconds the runner waits between one send and the next. */
  intervalMs: number;

  /**
   * The sending window, in whole hours of the SERVER's local day (0-23). The
   * runner only dispatches when the current local hour is within
   * `[windowStartHour, windowEndHour)` - e.g. 9 and 18 means "09:00 up to but not
   * including 18:00". Outside the window a RUNNING campaign simply idles and picks
   * up again when the window reopens; nothing is failed or lost. Set start 0 / end
   * 24 to send around the clock.
   */
  windowStartHour: number;
  windowEndHour: number;

  status: CampaignStatus;

  recipients: CampaignRecipient[];

  /** Segmentation of `body`, computed once - the same for every recipient. */
  partCount: number;
  isUnicode: boolean;

  /** Denormalised counters, so the list view need not walk `recipients`. */
  sentCount: number;
  failedCount: number;

  /** Set when the runner parks a campaign; shown to the operator. Null while running cleanly. */
  pausedReason: string | null;

  /**
   * Whether this pause is the runner's or a person's. Null whenever the campaign
   * is not PAUSED. See {@link PausedBy} - only a SYSTEM pause auto-resumes.
   */
  pausedBy: PausedBy | null;

  /** When the last recipient was attempted - the anchor for the pacing gate. */
  lastSendAt: Date | null;

  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicCampaignRecipient {
  to: string;
  name: string | null;
  /** This recipient's template variables, so the panel can show what was merged in. */
  vars: RecipientVars;
  status: RecipientStatus;
  messageId: string | null;
  error: string | null;
  sentAt: string | null;
}

export interface PublicCampaign {
  id: string;
  name: string;
  body: string;
  from: string | null;
  intervalSeconds: number;
  windowStartHour: number;
  windowEndHour: number;
  /** Whether the server clock is inside the sending window right now (null if not evaluated). */
  withinWindow: boolean | null;
  status: CampaignStatus;
  total: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  partCount: number;
  isUnicode: boolean;
  pausedReason: string | null;
  /** Lets the panel show "waiting to resume automatically" rather than a dead stop. */
  pausedBy: PausedBy | null;
  lastSendAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only included on the detail view; the list omits it to stay light. */
  recipients?: PublicCampaignRecipient[];
}

export function toPublicCampaign(
  campaign: Campaign,
  options: { includeRecipients?: boolean; nowHour?: number } = {},
): PublicCampaign {
  const total = campaign.recipients.length;
  const pendingCount = total - campaign.sentCount - campaign.failedCount;

  const base: PublicCampaign = {
    id: campaign.id,
    name: campaign.name,
    body: campaign.body,
    from: campaign.from,
    intervalSeconds: Math.round(campaign.intervalMs / 1000),
    windowStartHour: campaign.windowStartHour,
    windowEndHour: campaign.windowEndHour,
    // Only meaningful when the caller passes the current server hour; otherwise the
    // client cannot know the server's timezone and must not guess from its own.
    withinWindow:
      options.nowHour === undefined
        ? null
        : isWithinWindow(options.nowHour, campaign.windowStartHour, campaign.windowEndHour),
    status: campaign.status,
    total,
    sentCount: campaign.sentCount,
    failedCount: campaign.failedCount,
    pendingCount: pendingCount < 0 ? 0 : pendingCount,
    partCount: campaign.partCount,
    isUnicode: campaign.isUnicode,
    pausedReason: campaign.pausedReason,
    pausedBy: campaign.pausedBy,
    lastSendAt: campaign.lastSendAt?.toISOString() ?? null,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    completedAt: campaign.completedAt?.toISOString() ?? null,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };

  if (options.includeRecipients) {
    base.recipients = campaign.recipients.map((r) => ({
      to: r.to,
      name: r.name,
      vars: r.vars ?? {},
      status: r.status,
      messageId: r.messageId,
      error: r.error,
      sentAt: r.sentAt?.toISOString() ?? null,
    }));
  }

  return base;
}

// ---------------------------------------------------------------------------
// Sending window
// ---------------------------------------------------------------------------

/**
 * Is `hour` (0-23) inside the sending window `[startHour, endHour)`?
 *
 * The half-open interval is deliberate: end 18 means "stops at 18:00", so 17:59 is
 * in and 18:00 is out. Two shapes are supported so the window is not limited to a
 * daytime block:
 *   - start < end  (09-18): a normal daytime window.
 *   - start > end  (22-06): an overnight window that wraps past midnight.
 *   - start = end          : treated as "always on" (a zero-length gap makes no
 *                            sense as a restriction, and 0/0 is the natural "no window").
 */
export function isWithinWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true; // No restriction.
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // Overnight, wraps midnight.
}

/** "09:00–18:00" for display. `24` renders as `24:00` to read as end-of-day. */
export function formatWindow(startHour: number, endHour: number): string {
  const pad = (h: number) => String(h).padStart(2, '0') + ':00';
  return `${pad(startHour)}–${pad(endHour)}`;
}

// ---------------------------------------------------------------------------
// Number normalisation
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{7,14}$/;
/** A dialling code: a "+" and one to four digits, e.g. "+91", "+1", "+971". */
const COUNTRY_CODE = /^\+[1-9]\d{0,3}$/;

/**
 * Is this a usable default country code? The campaign form offers one so an
 * operator can paste 500 bare local numbers instead of typing "+91" 500 times.
 */
export function isValidCountryCode(cc: string): boolean {
  return COUNTRY_CODE.test(cc.trim());
}

/**
 * Turn one pasted number into E.164, or null if it cannot be salvaged.
 *
 * The ordinary send API deliberately *refuses* to guess a country code, because
 * guessing wrong sends an OTP to a stranger. A campaign is different: the
 * operator has explicitly chosen "these are all +91 numbers" for this batch, so
 * prefixing bare local numbers with that code is their instruction, not our
 * guess. A number already in +CC form is always left as-is.
 */
export function normalizeToE164(raw: string, defaultCc: string): string | null {
  // Drop the punctuation humans paste - spaces, dashes, dots, brackets.
  const cleaned = raw.replace(/[\s()\-.]/g, '');
  if (!cleaned) return null;

  let candidate: string;
  if (cleaned.startsWith('+')) {
    candidate = cleaned;
  } else if (/^\d+$/.test(cleaned)) {
    // Strip a national trunk "0" (09876543210 -> 9876543210) before prefixing.
    const local = cleaned.replace(/^0+/, '');
    if (!local) return null;
    candidate = defaultCc + local;
  } else {
    return null;
  }

  return E164.test(candidate) ? candidate : null;
}

export interface ParsedRecipients {
  /** Unique, normalised, in first-seen order. */
  valid: string[];
  /** The original tokens that could not be normalised. */
  invalid: string[];
  /** How many valid numbers were dropped as repeats of an earlier one. */
  duplicates: number;
}

/**
 * Parse a pasted blob - one number per line, or separated by commas / spaces /
 * semicolons - into a clean, de-duplicated list. Duplicates are dropped (texting
 * one person twice from a promo blast is the fastest way to get reported), and
 * invalid tokens are returned rather than silently swallowed, so the operator
 * can see exactly what was ignored.
 */
export function parseRecipients(input: string, defaultCc: string): ParsedRecipients {
  const tokens = input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;

  for (const token of tokens) {
    const normalized = normalizeToE164(token, defaultCc);
    if (!normalized) {
      invalid.push(token);
      continue;
    }
    if (seen.has(normalized)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized);
    valid.push(normalized);
  }

  return { valid, invalid, duplicates };
}

/** Segment a campaign body once - it is identical for every recipient. */
export function segmentBody(body: string): { partCount: number; isUnicode: boolean } {
  const { partCount, isUnicode } = segment(body);
  return { partCount, isUnicode };
}

// ---------------------------------------------------------------------------
// Personalisation - template variables
// ---------------------------------------------------------------------------

/**
 * A campaign body is a template, and anything in curly braces is a variable:
 * "Hi {name}, your rent of {amount} is due on {due_date}". Every recipient carries
 * its own values for those variables - one per mapped spreadsheet column - so one
 * body and one upload produce a different message for each row.
 *
 * There is no fixed set of variables and no fixed count. Whatever columns the
 * operator maps when they upload the file become the variables the body may use,
 * up to {@link MAX_VARIABLES}. `{name}` is the only one with special treatment,
 * and only because it predates the general mechanism: it is truncated hard and it
 * has a fallback, so a missing name degrades to "Hi there" instead of stopping the
 * send.
 *
 * Every other variable is strict on purpose. There is no sensible fallback for a
 * rent figure or a due date, and "your rent of  is due" is worse than not sending
 * at all - so a row with no value for a placeholder the body uses is FAILED by the
 * runner rather than sent half-filled, and a body whose placeholder no column
 * supplies is refused at creation. Both are loud, both are visible in the panel,
 * and neither can quietly text a stranger a broken sentence.
 *
 * Because braces mean "variable", they cannot also be literal text. A body reading
 * "Save {Rs 500} today" is rejected at creation with the placeholder named, rather
 * than blasted out verbatim to a thousand people.
 */

/**
 * What `{name}` becomes when a recipient has no name.
 *
 * A promo that reads "Hi , this is..." looks broken and screams "mail merge gone
 * wrong", so a missing name falls back to a neutral word rather than an empty gap.
 * "there" gives "Hi there," - the same thing a human writes when they don't know
 * who they're texting.
 */
export const DEFAULT_NAME_FALLBACK = 'there';

/** The one variable that carries a fallback and the short cap - see {@link renderTemplate}. */
export const NAME_VARIABLE = 'name';

/**
 * The longest a substituted name may be. A name over this is truncated (so
 * "Balasubramanian" sends as "Balasubr"), which keeps every personalised message a
 * predictable length - the operator budgets the template around an 8-character
 * name and a long one can never blow the segment count out.
 */
export const MAX_NAME_LENGTH = 8;

/**
 * The cap on every OTHER variable's value. Deliberately far more generous than
 * {@link MAX_NAME_LENGTH}: a name is a greeting and can be shortened without loss,
 * but an amount, a date or a booking reference truncated to eight characters is
 * simply wrong information. The cap exists only to stop one runaway spreadsheet
 * cell from turning a one-part message into a fifteen-part one.
 */
export const MAX_VARIABLE_LENGTH = 120;

/**
 * How many distinct variables one campaign may use. Twenty is far past any real
 * template and well inside what fits in a 1600-character body; the limit is there
 * so an uploaded sheet with two hundred columns cannot bloat every recipient row
 * in the campaign document.
 */
export const MAX_VARIABLES = 20;

/**
 * One `{placeholder}` in a body. Tolerant of what an operator actually types:
 * surrounding spaces (`{ name }`), any case (`{Name}`), and separators inside the
 * key (`{due date}`, `{due-date}`) - all of which {@link normalizeVarKey} folds
 * onto the same variable. The key must start with a letter, so `{20}` is not a
 * placeholder.
 */
const PLACEHOLDER = /\{\s*([A-Za-z][A-Za-z0-9 _.-]{0,39})\s*\}/g;

/** One recipient's template values, keyed by normalised variable name. */
export type RecipientVars = Record<string, string>;

/**
 * Fold a spreadsheet header or a typed placeholder onto a canonical variable key:
 * lowercase, letters/digits/underscore only.
 *
 * This is what lets a column headed "Due Date" back a `{due date}` in the body and
 * a `{Due_Date}` in the next line of it. Both sides of the merge run through here,
 * so they can never disagree about what a key means. Returns '' for anything that
 * normalises to nothing (a blank header, "###"), which callers treat as "not a
 * usable variable".
 */
export function normalizeVarKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
}

/**
 * The variables a body uses, normalised and de-duplicated, in first-seen order.
 * This is the list the panel offers columns for and the service validates against.
 */
export function extractPlaceholders(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const key = normalizeVarKey(match[1]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Does this body use the {name} placeholder? */
export function hasNamePlaceholder(body: string): boolean {
  return extractPlaceholders(body).includes(NAME_VARIABLE);
}

/**
 * The string one variable actually contributes to a message: trimmed, and capped
 * at the limit for its kind. Returns null when the recipient has no usable value -
 * the signal {@link renderTemplate} turns into either the name fallback or a
 * "missing" report.
 */
export function formatVarValue(key: string, raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const cap = key === NAME_VARIABLE ? MAX_NAME_LENGTH : MAX_VARIABLE_LENGTH;
  // trimEnd so a cut that lands on a space ("Bala Ram..." -> "Bala Ra") leaves no
  // trailing gap before the next word of the template.
  return value.slice(0, cap).trimEnd();
}

export interface RenderedBody {
  /** The body with every variable it could fill, filled. */
  body: string;
  /**
   * Variables the body uses that this recipient has no value for - `{name}`
   * excepted, since that one falls back. Non-empty means the message is NOT safe
   * to send: those placeholders are still sitting in `body` verbatim.
   */
  missing: string[];
}

/**
 * Fill a campaign template for one recipient.
 *
 * A missing `{name}` becomes {@link DEFAULT_NAME_FALLBACK}. Any other missing
 * variable is left in the body as-is AND reported in `missing`, so the caller can
 * refuse to send rather than deliver "your rent of {amount} is due". A body with
 * no placeholders comes back unchanged.
 */
export function renderTemplate(body: string, vars: RecipientVars = {}): RenderedBody {
  const missing: string[] = [];

  const rendered = body.replace(PLACEHOLDER, (whole: string, rawKey: string) => {
    const key = normalizeVarKey(rawKey);
    if (!key) return whole;

    const value = formatVarValue(key, vars[key]);
    if (value !== null) return value;

    if (key === NAME_VARIABLE) return DEFAULT_NAME_FALLBACK;

    if (!missing.includes(key)) missing.push(key);
    return whole;
  });

  return { body: rendered, missing };
}

/**
 * {@link renderTemplate}, keeping only the text. Accepts a bare name (or null) as
 * well as a variable map, because "the name" was the whole of personalisation
 * before columns existed and plenty of callers still have only that.
 */
export function renderBody(body: string, vars: RecipientVars | string | null = {}): string {
  const map: RecipientVars = typeof vars === 'string' || vars === null ? { [NAME_VARIABLE]: vars ?? '' } : vars;
  return renderTemplate(body, map).body;
}

/**
 * The longest message this campaign can produce, used to segment it honestly.
 *
 * With variables, "how many parts is this campaign?" has no single answer - a row
 * with a two-character amount and one with a forty-character address render to
 * different lengths. Segmenting the raw template would under-report every time, so
 * we segment the worst case instead: each variable filled with the longest value
 * any recipient has for it. What the panel then shows is "this campaign costs at
 * most N parts per message", which is the number worth budgeting against.
 */
export function worstCaseBody(body: string, recipients: ReadonlyArray<{ vars?: RecipientVars }>): string {
  const longest: RecipientVars = {};

  for (const key of extractPlaceholders(body)) {
    let best = key === NAME_VARIABLE ? DEFAULT_NAME_FALLBACK : '';
    for (const recipient of recipients) {
      const value = formatVarValue(key, recipient.vars?.[key]);
      if (value && value.length > best.length) best = value;
    }
    if (best) longest[key] = best;
  }

  return renderTemplate(body, longest).body;
}

// ---------------------------------------------------------------------------
// Named recipients (variables + number)
// ---------------------------------------------------------------------------

/**
 * One recipient as it arrives from a spreadsheet upload: a number, and the values
 * of whatever columns the operator mapped to variables. `name` is accepted
 * separately as well, for the single-column personalisation this feature grew out
 * of - it is folded into `vars.name`.
 */
export interface RecipientRow {
  phone: string;
  name?: string | null;
  vars?: RecipientVars | null;
}

/** A normalised recipient ready to become a {@link CampaignRecipient}. */
export interface NamedRecipient {
  to: string;
  name: string | null;
  vars: RecipientVars;
}

export interface ParsedNamedRecipients {
  /** Unique, normalised (E.164) recipients, each carrying its template variables. */
  valid: NamedRecipient[];
  /** Original tokens/numbers that could not be normalised. */
  invalid: string[];
  /** How many valid numbers were dropped as repeats of an earlier one. */
  duplicates: number;
}

/** Fold one uploaded row's columns into a clean variable map: normalised keys, non-blank values. */
function toVars(row: RecipientRow): RecipientVars {
  const vars: RecipientVars = {};

  for (const [rawKey, rawValue] of Object.entries(row.vars ?? {})) {
    const key = normalizeVarKey(rawKey);
    if (!key) continue;
    const value = String(rawValue ?? '').trim();
    if (value) vars[key] = value;
  }

  // The dedicated `name` field fills in only where the columns did not already
  // supply one, so an explicit name column is never overwritten by the legacy field.
  const name = row.name?.trim();
  if (name && !vars[NAME_VARIABLE]) vars[NAME_VARIABLE] = name;

  return vars;
}

/**
 * Merge the two ways recipients arrive - a structured upload that carries the
 * variable columns, and a pasted blob of bare numbers - into one clean,
 * de-duplicated list.
 *
 * Uploaded `rows` are processed first so that when the same number appears in both
 * the file and the paste box, the copy WITH its variables wins. De-duplication is
 * by normalised number (texting one person twice from a promo is how you get
 * reported), and invalid tokens are returned rather than swallowed so the operator
 * sees exactly what was skipped - the same contract as {@link parseRecipients},
 * just with the merge data attached.
 */
export function parseNamedRecipients(blob: string, rows: RecipientRow[], defaultCc: string): ParsedNamedRecipients {
  const seen = new Set<string>();
  const valid: NamedRecipient[] = [];
  const invalid: string[] = [];
  let duplicates = 0;

  const add = (rawPhone: string, vars: RecipientVars): void => {
    const normalized = normalizeToE164(rawPhone, defaultCc);
    if (!normalized) {
      invalid.push(rawPhone);
      return;
    }
    if (seen.has(normalized)) {
      duplicates += 1;
      return;
    }
    seen.add(normalized);
    valid.push({ to: normalized, name: vars[NAME_VARIABLE] ?? null, vars });
  };

  for (const row of rows) {
    if (!row || !row.phone) continue;
    add(String(row.phone), toVars(row));
  }

  for (const token of blob
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)) {
    add(token, {});
  }

  return { valid, invalid, duplicates };
}
