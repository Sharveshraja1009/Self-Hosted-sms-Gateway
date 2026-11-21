import { env } from '../config/env.js';

/**
 * Timezone-correct date handling.
 *
 * The daily SMS quota resets "at midnight" - but midnight *where*? The server
 * runs UTC in a container; the customer is in Asia/Kolkata. Getting this wrong
 * means the quota resets at 5:30am local, and someone's 2am OTPs get rejected
 * against yesterday's exhausted counter.
 *
 * So: never use `new Date().toISOString().slice(0, 10)` for a business day.
 * Always ask `localDateString()`, which resolves the calendar date in the
 * configured TIMEZONE.
 */

/**
 * The local calendar date as `YYYY-MM-DD`.
 *
 * `en-CA` is not an aesthetic choice - it is the locale whose short date format
 * *is* ISO-8601, which lets Intl do the timezone arithmetic (including DST) and
 * hand back exactly the string we want to store.
 */
export function localDateString(date: Date = new Date(), timeZone: string = env.TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * The instant the current local day ends - i.e. when the quota next resets.
 *
 * Computed by walking forward from `date` until the local calendar date changes,
 * rather than by adding 24 hours: on a DST transition the local day is 23 or 25
 * hours long, and a fixed offset would drift.
 */
export function endOfLocalDay(date: Date = new Date(), timeZone: string = env.TIMEZONE): Date {
  const today = localDateString(date, timeZone);

  // Start from "same time tomorrow", then walk back to the first instant of that
  // day at minute granularity. Cheap, exact, and DST-safe.
  let candidate = new Date(date.getTime() + 24 * 60 * 60 * 1000);

  while (localDateString(candidate, timeZone) !== today) {
    const earlier = new Date(candidate.getTime() - 60_000);
    if (localDateString(earlier, timeZone) === today) break;
    candidate = earlier;
  }

  return candidate;
}

/**
 * The half-open UTC interval `[from, to)` covering one LOCAL calendar day.
 *
 * What turns "2026-07-22" into something you can put in a Mongo query. The naive
 * version - `new Date('2026-07-22')` - parses as UTC midnight, which in
 * Asia/Kolkata is 05:30 that morning: a day window that starts mid-breakfast and
 * silently attributes five and a half hours of sends to the wrong day. Every
 * per-day figure in the panel would be quietly wrong, and only by a fraction, so
 * nobody would notice.
 *
 * Derived by measuring the zone's actual offset at that instant rather than
 * assuming one, so it stays right across a DST boundary.
 */
export function localDayRange(day: string, timeZone: string = env.TIMEZONE): { from: Date; to: Date } {
  const [year, month, date] = day.split('-').map((part) => Number(part));

  if (!year || !month || !date) {
    throw new Error(`Not a YYYY-MM-DD date: "${day}"`);
  }

  const wallClock = Date.UTC(year, month - 1, date, 0, 0, 0, 0);

  // Two passes: the first offset is measured at the wrong instant (we do not yet
  // know the right one), the second at a candidate that is already within hours
  // of the answer. That converges for every real zone, DST transitions included.
  let from = new Date(wallClock - offsetMs(new Date(wallClock), timeZone));
  from = new Date(wallClock - offsetMs(from, timeZone));

  return { from, to: endOfLocalDay(from, timeZone) };
}

/** How far ahead of UTC `timeZone` is at this instant, in milliseconds. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));

  return asUtc - at.getTime();
}

/** Seconds until the daily quota resets. Surfaced as `Retry-After` on a 429. */
export function secondsUntilLocalMidnight(date: Date = new Date(), timeZone: string = env.TIMEZONE): number {
  return Math.max(1, Math.ceil((endOfLocalDay(date, timeZone).getTime() - date.getTime()) / 1000));
}

/**
 * The hour of the day (0-23) in the configured timezone.
 *
 * Used to enforce a campaign's sending window - "only 09:00-18:00" - against the
 * SERVER's clock in the operator's timezone, not the phone's and not UTC. A
 * gateway in a UTC container would otherwise decide "business hours" five and a
 * half hours off from the operator in Asia/Kolkata. `hourCycle: 'h23'` pins the
 * output to 00-23 so midnight is 0, never 24.
 */
export function localHour(date: Date = new Date(), timeZone: string = env.TIMEZONE): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);

  return parseInt(formatted, 10);
}
