import { env } from '../../config/env.js';
import { BadRequestError, NotFoundError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import {
  type Campaign,
  CampaignStatus,
  extractPlaceholders,
  isValidCountryCode,
  MAX_VARIABLES,
  NAME_VARIABLE,
  type NamedRecipient,
  parseNamedRecipients,
  PausedBy,
  type RecipientRow,
  segmentBody,
  TERMINAL_CAMPAIGN_STATUSES,
  worstCaseBody,
} from '../../domain/campaign.js';
import { repositories } from '../../repositories/index.js';

/**
 * Campaign lifecycle - everything except the actual sending, which the runner
 * owns (campaign.runner.ts).
 *
 * The division of labour: this service creates and transitions campaigns in
 * response to operator actions (HTTP requests). The runner, a background timer,
 * is the *only* thing that advances a RUNNING campaign through its recipients.
 * Keeping those two writers apart is what avoids a race - the runner touches the
 * recipient list and counters; the operator only ever flips `status`.
 */

const log = createLogger('campaign');

export interface CreateCampaignResult {
  campaign: Campaign;
  /** Numbers that could not be parsed - surfaced so the operator sees what was skipped. */
  invalid: string[];
  /** How many valid numbers were dropped as duplicates. */
  duplicates: number;
  /** The template variables the body uses, normalised - what the operator mapped columns to. */
  variables: string[];
  /**
   * Recipients missing a value for at least one variable the body uses. They are
   * accepted (the rest of the list must not be held up by them) but the runner
   * FAILS them rather than sending a half-filled message, so the operator is told
   * the count up front.
   */
  incomplete: number;
}

/**
 * Check the body's variables against what the recipients actually carry.
 *
 * Two different problems, deliberately handled differently:
 *
 *  - A placeholder NO recipient supplies is an operator mistake - a typo in the
 *    body, or a column they forgot to map - and every single message would go out
 *    broken. That is refused here, before anything is stored.
 *  - A placeholder SOME recipients lack is a hole in the data, normal in any real
 *    spreadsheet. The campaign is created; the runner fails just those rows.
 *
 * `{name}` is exempt from both: it has a fallback, so a nameless row sends "Hi
 * there" rather than failing.
 */
function checkVariables(body: string, recipients: NamedRecipient[]): { variables: string[]; incomplete: number } {
  const variables = extractPlaceholders(body);

  if (variables.length > MAX_VARIABLES) {
    throw new BadRequestError(
      `A message may use at most ${MAX_VARIABLES} variables; this one uses ${variables.length}.`,
    );
  }

  const required = variables.filter((key) => key !== NAME_VARIABLE);

  const unsupplied = required.filter((key) => !recipients.some((r) => r.vars[key]));
  if (unsupplied.length > 0) {
    throw new BadRequestError(
      `Your message uses ${unsupplied.map((k) => `{${k}}`).join(', ')}, but no uploaded column supplies ` +
        `${unsupplied.length === 1 ? 'that value' : 'those values'}. Map a column to ` +
        `${unsupplied.length === 1 ? 'it' : 'each of them'}, or remove the braces from the message.`,
    );
  }

  const incomplete = recipients.filter((r) => required.some((key) => !r.vars[key])).length;

  return { variables, incomplete };
}

export const campaignService = {
  async create(params: {
    userId: string;
    name: string;
    body: string;
    from: string | null;
    /** Pasted numbers, no names. */
    recipients?: string;
    /** Uploaded rows - a number and its variable values, for {name}, {amount}, and anything else the body uses. */
    recipientRows?: RecipientRow[];
    intervalSeconds?: number;
    windowStartHour?: number;
    windowEndHour?: number;
    countryCode: string;
    start: boolean;
  }): Promise<CreateCampaignResult> {
    if (!isValidCountryCode(params.countryCode)) {
      throw new BadRequestError(
        `"${params.countryCode}" is not a valid dialling code (expected something like "+91").`,
      );
    }

    const { valid, invalid, duplicates } = parseNamedRecipients(
      params.recipients ?? '',
      params.recipientRows ?? [],
      params.countryCode,
    );

    if (valid.length === 0) {
      throw new BadRequestError(
        'No valid phone numbers found. Numbers must be 10-digit local (they get your chosen country code) or full +CC form.',
      );
    }

    if (valid.length > env.CAMPAIGN_MAX_RECIPIENTS) {
      throw new BadRequestError(
        `A campaign may target at most ${env.CAMPAIGN_MAX_RECIPIENTS} numbers; this list has ${valid.length}.`,
      );
    }

    // The pace, clamped to the floor. An operator can go slower than the default
    // but never below the safety minimum - that floor is what protects the SIMs.
    const requestedMs = (params.intervalSeconds ?? env.CAMPAIGN_DEFAULT_INTERVAL_MS / 1000) * 1000;
    const intervalMs = Math.max(env.CAMPAIGN_MIN_INTERVAL_MS, Math.round(requestedMs));

    const windowStartHour = params.windowStartHour ?? env.CAMPAIGN_WINDOW_START_HOUR;
    const windowEndHour = params.windowEndHour ?? env.CAMPAIGN_WINDOW_END_HOUR;

    // A window that never opens would silently never send. Reject it loudly.
    if (windowStartHour === windowEndHour) {
      // Equal is the sentinel for "no restriction" only when both are the extremes;
      // any other equal pair (e.g. 9 and 9) is a mistake, not "always on".
      if (!(windowStartHour === 0 && windowEndHour === 0)) {
        throw new BadRequestError('The sending window start and end hours must differ (use 0 and 24 for all day).');
      }
    }

    const { variables, incomplete } = checkVariables(params.body, valid);

    // Segment the LONGEST message this campaign can produce, not the raw template:
    // with variables the two differ, and under-reporting the part count is how an
    // operator budgets for one SMS and pays for three.
    const { partCount, isUnicode } = segmentBody(worstCaseBody(params.body, valid));

    const campaign = await repositories().campaigns.create({
      userId: params.userId,
      name: params.name,
      body: params.body,
      from: params.from,
      intervalMs,
      windowStartHour,
      windowEndHour,
      partCount,
      isUnicode,
      recipients: valid,
    });

    log.info('Campaign created', {
      campaignId: campaign.id,
      recipients: valid.length,
      invalid: invalid.length,
      duplicates,
      variables,
      incomplete,
      intervalMs,
      window: `${windowStartHour}-${windowEndHour}`,
      partCount,
    });

    if (params.start) {
      const started = await this.start(params.userId, campaign.id);
      return { campaign: started, invalid, duplicates, variables, incomplete };
    }

    return { campaign, invalid, duplicates, variables, incomplete };
  },

  async list(userId: string, query: { page: number; limit: number; status?: Campaign['status'] }) {
    return repositories().campaigns.list({ userId, ...query });
  },

  async findForUser(userId: string, campaignId: string): Promise<Campaign | null> {
    const campaign = await repositories().campaigns.findById(campaignId);
    // Ownership, not just existence - same reasoning as smsService.findForUser.
    if (!campaign || campaign.userId !== userId) return null;
    return campaign;
  },

  /**
   * Start or resume. Legal from DRAFT (first start) and PAUSED (resume). Starting
   * clears any paused-reason and stamps `startedAt` the first time. The runner
   * picks it up on its next tick - within a second - and begins advancing it.
   */
  async start(userId: string, campaignId: string): Promise<Campaign> {
    const campaign = await this.requireOwned(userId, campaignId);

    if (campaign.status === CampaignStatus.RUNNING) {
      return campaign; // Idempotent: already running.
    }
    if (TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new BadRequestError(`This campaign is ${campaign.status.toLowerCase()} and cannot be started again.`);
    }

    const updated = await repositories().campaigns.update(campaignId, {
      status: CampaignStatus.RUNNING,
      pausedReason: null,
      // Clear the ownership of the old pause along with its reason. A campaign
      // that is running is not paused by anyone, and leaving OPERATOR behind here
      // would make the next system pause un-resumable.
      pausedBy: null,
      startedAt: campaign.startedAt ?? new Date(),
    });

    log.info('Campaign started', { campaignId, from: campaign.from ?? 'auto' });
    return updated;
  },

  /** Operator pause. Only meaningful while RUNNING. */
  async pause(userId: string, campaignId: string): Promise<Campaign> {
    const campaign = await this.requireOwned(userId, campaignId);

    if (campaign.status !== CampaignStatus.RUNNING) {
      throw new BadRequestError(`Only a running campaign can be paused; this one is ${campaign.status.toLowerCase()}.`);
    }

    const updated = await repositories().campaigns.update(campaignId, {
      status: CampaignStatus.PAUSED,
      pausedReason: 'Paused by you.',
      // OPERATOR, so the runner's auto-resume leaves it alone however healthy the
      // fleet gets. A deliberate stop must never be undone behind the operator's back.
      pausedBy: PausedBy.OPERATOR,
    });

    log.info('Campaign paused by operator', { campaignId });
    return updated;
  },

  /** Abandon for good. Anything not already terminal can be cancelled. */
  async cancel(userId: string, campaignId: string): Promise<Campaign> {
    const campaign = await this.requireOwned(userId, campaignId);

    if (TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new BadRequestError(`This campaign is already ${campaign.status.toLowerCase()}.`);
    }

    const updated = await repositories().campaigns.update(campaignId, {
      status: CampaignStatus.CANCELLED,
      completedAt: new Date(),
    });

    log.info('Campaign cancelled', { campaignId, sent: campaign.sentCount });
    return updated;
  },

  /** Load a campaign and assert ownership, or 404 - shared by every mutation. */
  async requireOwned(userId: string, campaignId: string): Promise<Campaign> {
    const campaign = await this.findForUser(userId, campaignId);
    if (!campaign) {
      throw new NotFoundError('Campaign');
    }
    return campaign;
  },
};
