import { AppError, ErrorCode } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { onShutdown } from '../../core/shutdown.js';
import { localHour } from '../../core/time.js';
import {
  type Campaign,
  CampaignStatus,
  isWithinWindow,
  PausedBy,
  RecipientStatus,
  renderTemplate,
} from '../../domain/campaign.js';
import { MessageStatus } from '../../domain/message.js';
import { repositories } from '../../repositories/index.js';
import { route } from '../sms/sim-router.js';
import { type SendResult, smsService } from '../sms/sms.service.js';

/**
 * The campaign runner - a single background timer that drives every RUNNING
 * campaign forward, one recipient at a time, respecting each campaign's own pace.
 *
 * Why a poll loop and not a job queue: this is the thin, Redis-free slice. Every
 * second the runner asks the store for RUNNING campaigns and, for each one whose
 * interval has elapsed since its last send, dispatches the next recipient. The
 * state that decides "what next" - the recipient list, the cursor (the first
 * PENDING entry), `lastSendAt` - all lives in the campaign document, so a process
 * restart loses nothing: the new process polls, finds the same RUNNING campaigns,
 * and carries on from exactly where the old one stopped.
 *
 * Two invariants keep it honest:
 *
 *  1. **One send in flight per campaign.** A send is a network round-trip; the
 *     tick fires faster than that. `inFlight` stops a slow send from being driven
 *     twice concurrently and double-charging a recipient.
 *
 *  2. **Re-read before every send.** `listByStatus` returns a snapshot; between
 *     the poll and the send an operator may have paused or cancelled the
 *     campaign. We re-read inside the lock and bail unless it is still RUNNING, so
 *     a pause always takes effect before the next number goes out.
 */

const log = createLogger('campaign-runner');

/** How often the loop wakes to look for due campaigns. Finer than any real interval. */
const TICK_MS = 1_000;

/** The two failures that mean "stop, do not burn the list" rather than "skip this number". */
const RECOVERABLE_CODES = new Set<string>([ErrorCode.DAILY_LIMIT_EXCEEDED, ErrorCode.NO_GATEWAY_AVAILABLE]);

/** The send surface the runner needs, narrowed so a test can supply a fake. */
export type SendFn = (params: {
  userId: string;
  recipient: string;
  body: string;
  clientRef: string | null;
  from: string | null;
}) => Promise<SendResult>;

export interface RunnerDeps {
  send: SendFn;
  now: () => number;
  /** The current hour (0-23) in the server's timezone. Injected so tests are deterministic. */
  currentHour: () => number;
  /**
   * Could a send go out right now for this user, on this pin? Used only to decide
   * whether a system-paused campaign may resume - it must not send anything or
   * spend any quota, which is why it asks the router rather than the sender.
   */
  canSend: (userId: string, from: string | null) => Promise<boolean>;
}

const defaultDeps: RunnerDeps = {
  send: (params) => smsService.send(params),
  now: () => Date.now(),
  currentHour: () => localHour(),
  // The exact question the pause answered, asked again. Reusing `route` rather
  // than re-deriving "is a phone up, does a SIM have headroom" guarantees the
  // resume condition can never drift from the pause condition - if it could, a
  // campaign would resume into an immediate re-pause, forever.
  canSend: async (userId, from) => (await route(userId, from)).ok,
};

/**
 * How often a system-paused campaign is re-probed to see if its blocker cleared.
 *
 * Not every tick. A probe walks the connected phones and reads a gateway row per
 * connection, and a campaign parked overnight would run that 28,800 times before
 * breakfast to learn the same thing each time. Thirty seconds is far below any
 * human's reaction time - which is what this replaces - and costs nothing.
 */
const RESUME_PROBE_MS = 30_000;

/** Campaigns with a send currently in flight, so a fast tick cannot double-dispatch. */
const inFlight = new Set<string>();

/**
 * campaignId -> when we last probed it. In memory on purpose: losing it on a
 * restart just means one immediate probe, which is the right thing to do anyway.
 */
const lastProbeAt = new Map<string, number>();

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Advance one campaign by at most one recipient.
 *
 * Returns quietly (a no-op) when the campaign is not yet due, is already being
 * processed, or has been paused/cancelled out from under us. Exported for the
 * tests, which call it directly with a fake clock and a fake sender rather than
 * waiting on wall-clock intervals.
 */
export async function stepCampaign(campaign: Campaign, deps: RunnerDeps = defaultDeps): Promise<void> {
  if (inFlight.has(campaign.id)) return;

  // Pacing gate. The first send (lastSendAt === null) goes immediately; every
  // one after waits out the interval. Checked against the snapshot before taking
  // the lock, so a not-yet-due campaign costs nothing.
  const elapsed = campaign.lastSendAt ? deps.now() - campaign.lastSendAt.getTime() : Infinity;
  if (elapsed < campaign.intervalMs) return;

  inFlight.add(campaign.id);
  try {
    // Re-read: the snapshot from listByStatus may be stale. An operator could have
    // paused or cancelled since; a previous tick could have advanced it. Trust the
    // store, not the argument, for anything we are about to act on.
    const fresh = await repositories().campaigns.findById(campaign.id);
    if (!fresh || fresh.status !== CampaignStatus.RUNNING) return;

    // The sending window. Outside business hours the campaign just idles - it stays
    // RUNNING and resumes on its own when the window reopens, so a promo never goes
    // out at 3am. Checked against the SERVER's local hour, not the phone's clock.
    if (!isWithinWindow(deps.currentHour(), fresh.windowStartHour, fresh.windowEndHour)) {
      return;
    }

    // Re-check the gate against the fresh record too - lastSendAt may have moved.
    const freshElapsed = fresh.lastSendAt ? deps.now() - fresh.lastSendAt.getTime() : Infinity;
    if (freshElapsed < fresh.intervalMs) return;

    const index = fresh.recipients.findIndex((r) => r.status === RecipientStatus.PENDING);
    if (index === -1) {
      await repositories().campaigns.update(fresh.id, {
        status: CampaignStatus.COMPLETED,
        completedAt: new Date(deps.now()),
        pausedReason: null,
      });
      log.info('Campaign completed', { campaignId: fresh.id, sent: fresh.sentCount, failed: fresh.failedCount });
      return;
    }

    const recipient = fresh.recipients[index]!;

    // Personalise: merge this recipient's column values into the template. A body
    // with no placeholders comes back unchanged, so a plain campaign is unaffected.
    const { body, missing } = renderTemplate(fresh.body, recipient.vars);

    // A hole in the spreadsheet - this row has no value for a variable the body
    // uses. Sending would deliver "your rent of {amount} is due" verbatim, so the
    // row fails and the campaign carries on; one empty cell must not stop the run,
    // and must not go out either.
    //
    // `lastSendAt` is deliberately NOT stamped. The pacing clock exists to keep a
    // SIM under a carrier's radar, and nothing was handed to a SIM here - spending
    // a full interval per empty cell would idle a campaign for hours over rows that
    // never touch the network.
    if (missing.length > 0) {
      const skipped = fresh.recipients.map((r, i) =>
        i === index
          ? {
              ...r,
              status: RecipientStatus.FAILED,
              error: `No value for ${missing.map((key) => `{${key}}`).join(', ')} in this row.`,
              sentAt: new Date(deps.now()),
            }
          : r,
      );

      await repositories().campaigns.update(fresh.id, {
        recipients: skipped,
        failedCount: fresh.failedCount + 1,
      });

      log.warn('Campaign recipient failed - no value for a variable the message uses', {
        campaignId: fresh.id,
        recipient: recipient.to,
        missing,
      });
      return;
    }

    try {
      const result = await deps.send({
        userId: fresh.userId,
        recipient: recipient.to,
        body,
        from: fresh.from,
        clientRef: `campaign:${fresh.id}`,
      });

      // Accepted but no phone was connected: the message is sitting in QUEUED. Do
      // NOT plough on dumping the whole list into the backlog - that throws away
      // the pacing entirely. Park the campaign and leave this recipient PENDING so
      // resuming re-sends it once a phone is online.
      if (!result.dispatched) {
        // ...but first take the queued message back, or the recipient gets it
        // TWICE. Leaving it QUEUED means the next phone to connect drains it from
        // the backlog, while the recipient - still PENDING here - is sent a second
        // copy when the campaign resumes. That is not theoretical: it is exactly
        // how one number in this project's own history received the same promo
        // twice, from two different message rows, eighteen seconds apart.
        //
        // Cancelling is the honest half of "leave this recipient PENDING": the
        // resume owns the send, so nothing else may hold a claim on it.
        //
        // Best-effort, and deliberately so: if the withdrawal fails we still have
        // to pause. A campaign left RUNNING because of it would dump every
        // remaining number into the backlog at once - unpaced, from one SIM - and
        // that is a far worse outcome than one possible duplicate.
        try {
          await repositories().messages.update(result.message.id, {
            status: MessageStatus.CANCELLED,
            errorCode: 'CAMPAIGN_PAUSED',
            errorMessage: 'Withdrawn from the queue when the campaign paused. It is re-sent on resume.',
          });
        } catch (error) {
          log.warn('Could not withdraw the queued message while pausing - it may be delivered twice', {
            campaignId: fresh.id,
            messageId: result.message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        await repositories().campaigns.update(fresh.id, {
          status: CampaignStatus.PAUSED,
          pausedReason: 'No gateway phone is connected. Waiting for one to come back online.',
          pausedBy: PausedBy.SYSTEM,
        });
        log.warn('Campaign paused - no gateway online', {
          campaignId: fresh.id,
          withdrew: result.message.id,
        });
        return;
      }

      const recipients = fresh.recipients.map((r, i) =>
        i === index
          ? {
              ...r,
              status: RecipientStatus.SENT,
              messageId: result.message.id,
              error: null,
              sentAt: new Date(deps.now()),
            }
          : r,
      );

      await repositories().campaigns.update(fresh.id, {
        recipients,
        sentCount: fresh.sentCount + 1,
        lastSendAt: new Date(deps.now()),
        pausedReason: null,
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : ErrorCode.INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : String(error);

      // Recoverable: every SIM at its cap, or a pinned sender offline. The blocker
      // clears with time or an operator action, so park the campaign with the
      // reason and leave this recipient PENDING to retry on resume.
      if (RECOVERABLE_CODES.has(code)) {
        await repositories().campaigns.update(fresh.id, {
          status: CampaignStatus.PAUSED,
          pausedReason: message,
          pausedBy: PausedBy.SYSTEM,
        });
        log.warn('Campaign paused - recoverable send failure', { campaignId: fresh.id, code });
        return;
      }

      // Anything else is this one number's problem (an odd address, say). Mark it
      // FAILED and let the campaign keep going - one bad row must not stop the run.
      const recipients = fresh.recipients.map((r, i) =>
        i === index ? { ...r, status: RecipientStatus.FAILED, error: message, sentAt: new Date(deps.now()) } : r,
      );

      await repositories().campaigns.update(fresh.id, {
        recipients,
        failedCount: fresh.failedCount + 1,
        lastSendAt: new Date(deps.now()),
      });
      log.warn('Campaign recipient failed', { campaignId: fresh.id, code, recipient: recipient.to });
    }
  } finally {
    inFlight.delete(campaign.id);
  }
}

/**
 * Un-park one campaign if the wall it hit is gone.
 *
 * This is what turns a 50,000-name list into something you start once. Both
 * blockers the runner parks on - no phone connected, every SIM at its cap - clear
 * without anyone doing anything: a phone reconnects, or local midnight rolls the
 * quota counters over. Before this, each of those cost a full day of sending,
 * because the campaign sat PAUSED until a human happened to look at the panel.
 *
 * Deliberately narrow, because "resume by itself" is exactly the behaviour you
 * want to be sure of:
 *
 *  - **Only SYSTEM pauses.** An operator pause, or a pause from before this field
 *    existed, is left strictly alone.
 *  - **Only when a send would actually succeed now.** It asks the router the same
 *    question the failed send asked. No probe, no resume - so a campaign cannot
 *    flap between RUNNING and PAUSED, and the midnight quota reset needs no
 *    special case: the router simply starts saying yes again.
 *  - **Never sends anything.** Routing is a pure query; the send happens on the
 *    next ordinary tick, through the same paced path as every other recipient.
 */
export async function tryResume(campaign: Campaign, deps: RunnerDeps = defaultDeps): Promise<void> {
  if (campaign.pausedBy !== PausedBy.SYSTEM) return;

  const since = lastProbeAt.get(campaign.id);
  if (since !== undefined && deps.now() - since < RESUME_PROBE_MS) return;
  lastProbeAt.set(campaign.id, deps.now());

  // Re-read before acting, for the same reason stepCampaign does: the snapshot may
  // predate an operator pressing pause or cancel, and resuming a campaign someone
  // just stopped would be the worst possible bug in this function.
  const fresh = await repositories().campaigns.findById(campaign.id);
  if (!fresh || fresh.status !== CampaignStatus.PAUSED || fresh.pausedBy !== PausedBy.SYSTEM) return;

  if (!(await deps.canSend(fresh.userId, fresh.from))) return;

  await repositories().campaigns.update(fresh.id, {
    status: CampaignStatus.RUNNING,
    pausedReason: null,
    pausedBy: null,
  });

  // The probe stamp is deliberately NOT cleared here. A phone on bad wifi can
  // connect and drop repeatedly; without a surviving backoff the cycle would be
  // resume -> send -> pause -> resume, each lap creating and cancelling a message
  // row. Keeping the stamp caps that at one lap per RESUME_PROBE_MS.
  log.info('Campaign resumed automatically - the blocker cleared', {
    campaignId: fresh.id,
    was: fresh.pausedReason,
  });
}

/**
 * One poll: advance every RUNNING campaign, and try to revive every system-paused
 * one. Both run concurrently across campaigns - they touch different documents,
 * and a campaign is in exactly one of the two sets.
 */
async function tick(deps: RunnerDeps = defaultDeps): Promise<void> {
  const [running, paused] = await Promise.all([
    repositories().campaigns.listByStatus(CampaignStatus.RUNNING),
    repositories().campaigns.listByStatus(CampaignStatus.PAUSED),
  ]);

  await Promise.all([
    ...running.map((campaign) => stepCampaign(campaign, deps)),
    ...paused.map((campaign) => tryResume(campaign, deps)),
  ]);
}

/**
 * Start the background loop. Idempotent. Called once from the composition root,
 * after the repositories are bound to MongoDB.
 *
 * `unref()` so this timer alone never keeps the process alive: on shutdown the
 * loop must not be the reason Node refuses to exit.
 */
export function startCampaignRunner(): void {
  if (timer) return;

  timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      log.error('Campaign tick failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }, TICK_MS);
  timer.unref?.();

  onShutdown('campaign runner', stopCampaignRunner, 20);
  log.info('Campaign runner started', { tickMs: TICK_MS });
}

export function stopCampaignRunner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('Campaign runner stopped');
  }
}

/** Test-only: drive one poll synchronously with injected deps. */
export const __test = { tick, inFlight, lastProbeAt };
