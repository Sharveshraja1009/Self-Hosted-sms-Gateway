import { env } from '../../config/env.js';
import { createLogger } from '../../core/logger.js';
import { localDateString, localDayRange } from '../../core/time.js';
import { repositories } from '../../repositories/index.js';

/**
 * Per-SIM daily quota.
 *
 * This is the single most important safety mechanism in the whole project, and it
 * exists to stop you getting your own phone numbers permanently blacklisted.
 *
 * Indian carriers cap ordinary consumer SIMs at roughly 100 SMS/day, and - more
 * dangerously - they profile *shape*, not just volume. A SIM that suddenly emits
 * a steady stream of near-identical messages looks exactly like the bulk
 * commercial traffic that is supposed to go through a DLT-registered aggregator.
 * The consequence is not a rate-limit error; it is the number being cut off, often
 * permanently, and often several at once because they are registered to the same
 * person.
 *
 * So the dispatcher does two things with these counts:
 *
 *  1. **Refuses to exceed the cap.** A SIM at its limit is skipped, not squeezed.
 *  2. **Prefers the least-used line.** Spreading 400 messages evenly over 8 SIMs
 *     (50 each) is invisible; pushing 100 through one SIM and nothing through the
 *     rest is a flare.
 *
 * The counter is keyed on the LOCAL date in the configured TIMEZONE, not UTC,
 * because the carrier's day rolls over at local midnight - and a gateway in
 * Asia/Kolkata resetting its counters at 05:30 IST would let a SIM send 100
 * messages twice inside one carrier-day.
 *
 * The counter lives in memory, but it is REBUILT FROM THE MESSAGES at boot.
 *
 * It used to be purely in-memory, on the reasoning that losing the count on a
 * restart just makes the gateway briefly over-cautious. That reasoning was
 * backwards: an empty counter is not cautious, it is *blind*. A process restarted
 * at noon believed every SIM had sent nothing, so a SIM that had already done 90
 * could be handed another 100 - precisely the burst this whole file exists to
 * prevent - and the panel cheerfully displayed "0 / 100" while it happened.
 *
 * Rebuilding from the message rows avoids the failure mode that argued against
 * persistence, too: nothing is *stored*, so there is no stale counter to go on
 * believing. The count is derived, on demand, from what the SIMs actually
 * radiated during the current local day, which is a fact rather than a tally
 * someone forgot to reset. Phase 4 can move the live increments into Redis; the
 * rebuild stays useful either way.
 */

const log = createLogger('sim-quota');

interface Counter {
  /** The local calendar date this count belongs to, e.g. "2026-07-11". */
  date: string;
  count: number;
}

/** `${deviceId}:${subscriptionId}` -> today's count. */
const counters = new Map<string, Counter>();

function key(deviceId: string, subscriptionId: number): string {
  return `${deviceId}:${subscriptionId}`;
}

function today(): string {
  // Defaults to env.TIMEZONE - the carrier's day, not UTC's.
  return localDateString();
}

/**
 * How many messages this SIM has sent today.
 *
 * Returns 0 - and quietly discards the old count - once the local date rolls
 * over. There is no cron job and nothing to schedule: the reset happens because
 * the date in the key no longer matches, so a process that was asleep at midnight
 * cannot miss it.
 */
export function usedToday(deviceId: string, subscriptionId: number): number {
  const entry = counters.get(key(deviceId, subscriptionId));

  if (!entry || entry.date !== today()) return 0;

  return entry.count;
}

export function remainingToday(deviceId: string, subscriptionId: number): number {
  return Math.max(0, env.SIM_DAILY_SMS_LIMIT - usedToday(deviceId, subscriptionId));
}

/** True when this SIM still has headroom. */
export function hasHeadroom(deviceId: string, subscriptionId: number): boolean {
  return remainingToday(deviceId, subscriptionId) > 0;
}

/**
 * Records that a SIM is about to send `parts` messages.
 *
 * Counts PARTS, not messages, because that is what the carrier counts. A 400-
 * character message is 3 SMS as far as your daily cap is concerned, and a gateway
 * that counted it as 1 would sail past the limit on long messages - which is
 * precisely the traffic most likely to be flagged.
 */
export function consume(deviceId: string, subscriptionId: number, parts: number): void {
  const k = key(deviceId, subscriptionId);
  const entry = counters.get(k);
  const date = today();

  if (!entry || entry.date !== date) {
    counters.set(k, { date, count: parts });
    return;
  }

  entry.count += parts;
}

/**
 * Rebuild today's counters from the messages that have actually been dispatched.
 *
 * Called at boot, before the listener opens, so the very first send after a
 * restart is judged against the day's real usage rather than a blank slate. Also
 * safe to call later: it REPLACES each line's count with the persisted total, and
 * every increment is written to a message row immediately after `consume()`, so a
 * mid-day rebuild can lose at most the one send currently between the two.
 *
 * Failing to rebuild is not fatal - the gateway still runs, just over-cautiously
 * from zero - so this logs and carries on rather than aborting the boot. A gateway
 * that will not start is worse than one whose counters are conservative.
 */
export async function rebuildFromMessages(): Promise<void> {
  const date = today();

  try {
    const { from, to } = localDayRange(date);
    // null userId: the cap belongs to the physical SIM, not to a tenant, and at
    // boot there is no user to scope to anyway.
    const rows = await repositories().messages.dailyLineStats(null, from, to);

    let lines = 0;
    let parts = 0;

    for (const row of rows) {
      // Rows from before per-line stamping (or that never reached a SIM) cannot be
      // attributed to a line. Counting them against an arbitrary SIM would be worse
      // than not counting them.
      if (!row.deviceId || row.subscriptionId === null) continue;

      counters.set(key(row.deviceId, row.subscriptionId), { date, count: row.parts });
      lines += 1;
      parts += row.parts;
    }

    log.info('Rebuilt per-SIM daily quota from message history', { date, lines, parts });
  } catch (error) {
    log.error('Could not rebuild the per-SIM daily quota - starting from zero for today', {
      date,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Test helper. */
export function resetQuotas(): void {
  counters.clear();
}
