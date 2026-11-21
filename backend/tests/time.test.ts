import { describe, expect, it } from 'vitest';

import { endOfLocalDay, localDateString, localDayRange, secondsUntilLocalMidnight } from '../src/core/time.js';

/**
 * Timezone correctness for the daily quota.
 *
 * These look like trivia. They are not: the daily SMS limit resets at local
 * midnight, and if this logic is wrong the reset happens at (say) 05:30 local,
 * which means a customer's 2am OTPs get rejected against yesterday's exhausted
 * counter. That is a production outage caused entirely by `.toISOString()`.
 */
describe('localDateString', () => {
  it('resolves the calendar date in the TARGET zone, not the server zone', () => {
    // 2026-07-11 20:00 UTC. In Kolkata (+05:30) it is already 01:30 on the 12th.
    const instant = new Date('2026-07-11T20:00:00Z');

    expect(localDateString(instant, 'UTC')).toBe('2026-07-11');
    expect(localDateString(instant, 'Asia/Kolkata')).toBe('2026-07-12');
    // ...and in Los Angeles (-07:00) it is still the 11th, early afternoon.
    expect(localDateString(instant, 'America/Los_Angeles')).toBe('2026-07-11');
  });

  it('handles the moment just before local midnight', () => {
    // 18:29 UTC = 23:59 Kolkata. Still "today".
    expect(localDateString(new Date('2026-07-11T18:29:00Z'), 'Asia/Kolkata')).toBe('2026-07-11');
    // 18:30 UTC = 00:00 Kolkata. Now "tomorrow" - the quota has reset.
    expect(localDateString(new Date('2026-07-11T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-07-12');
  });

  it('emits a sortable YYYY-MM-DD string (it is a database key)', () => {
    expect(localDateString(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
    expect(localDateString(new Date('2026-12-31T12:00:00Z'), 'UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('endOfLocalDay', () => {
  it('lands on the first instant of the next local day', () => {
    const now = new Date('2026-07-11T10:00:00Z'); // 15:30 in Kolkata
    const boundary = endOfLocalDay(now, 'Asia/Kolkata');

    // The boundary itself must already be "tomorrow"...
    expect(localDateString(boundary, 'Asia/Kolkata')).toBe('2026-07-12');
    // ...and one minute earlier must still be "today". That is what makes it
    // *the* boundary rather than merely some time tomorrow.
    expect(localDateString(new Date(boundary.getTime() - 60_000), 'Asia/Kolkata')).toBe('2026-07-11');
  });

  it('survives a DST transition, where the local day is not 24 hours long', () => {
    // 2026-03-08: US clocks spring forward. That local day is 23 hours long, so
    // "now + 24h" would overshoot into the day after next.
    const now = new Date('2026-03-08T08:00:00Z'); // 00:00 PST
    const boundary = endOfLocalDay(now, 'America/Los_Angeles');

    expect(localDateString(boundary, 'America/Los_Angeles')).toBe('2026-03-09');
    expect(localDateString(new Date(boundary.getTime() - 60_000), 'America/Los_Angeles')).toBe('2026-03-08');
  });
});

describe('localDayRange', () => {
  it('spans the local day, not the UTC one', () => {
    const { from, to } = localDayRange('2026-07-22', 'Asia/Kolkata');

    // Kolkata is +05:30, so the day starts at 18:30 the previous evening UTC.
    // The naive `new Date('2026-07-22')` would start it five and a half hours
    // late and quietly attribute that morning's sends to the wrong day.
    expect(from.toISOString()).toBe('2026-07-21T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-07-22T18:30:00.000Z');
  });

  it('brackets exactly the instants belonging to that local date', () => {
    const { from, to } = localDayRange('2026-07-22', 'Asia/Kolkata');

    expect(localDateString(from, 'Asia/Kolkata')).toBe('2026-07-22');
    expect(localDateString(new Date(from.getTime() - 1), 'Asia/Kolkata')).toBe('2026-07-21');
    // Half-open: `to` is the first instant of the NEXT day, so a query using
    // `< to` cannot double-count the midnight message.
    expect(localDateString(to, 'Asia/Kolkata')).toBe('2026-07-23');
  });

  it('handles a day that is not 24 hours long', () => {
    // US clocks spring forward on 2026-03-08: that local day is 23 hours.
    const { from, to } = localDayRange('2026-03-08', 'America/Los_Angeles');

    expect(to.getTime() - from.getTime()).toBe(23 * 3600 * 1000);
    expect(localDateString(from, 'America/Los_Angeles')).toBe('2026-03-08');
  });

  it('rejects anything that is not a calendar date', () => {
    expect(() => localDayRange('not-a-date', 'UTC')).toThrow();
  });
});

describe('secondsUntilLocalMidnight', () => {
  it('counts down to the reset, never returning zero or negative', () => {
    const now = new Date('2026-07-11T18:00:00Z'); // 23:30 Kolkata - 30 min to go
    const seconds = secondsUntilLocalMidnight(now, 'Asia/Kolkata');

    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(30 * 60 + 1);
  });

  it('is a full day just after the reset', () => {
    const now = new Date('2026-07-11T18:31:00Z'); // 00:01 Kolkata
    const seconds = secondsUntilLocalMidnight(now, 'Asia/Kolkata');

    expect(seconds).toBeGreaterThan(23 * 3600);
  });
});
