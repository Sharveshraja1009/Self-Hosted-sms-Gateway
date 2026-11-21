import { createLogger } from '../../core/logger.js';
import { type Gateway, linesOf, type SimLine } from '../../domain/gateway.js';
import { repositories } from '../../repositories/index.js';
import { type Connection, gatewayRegistry } from '../gateway/gateway.registry.js';
import { hasHeadroom, remainingToday, usedToday } from './sim-quota.js';

/**
 * Choosing which SIM sends a message.
 *
 * The unit of routing is the LINE, not the phone. With four dual-SIM handsets you
 * have four gateways but eight numbers, and the daily quota, the "from" address
 * and the carrier's patience all belong to the number.
 *
 * Two ways in:
 *
 *  - **Pinned.** The caller passed `from`, so a specific number must send it -
 *    e.g. an OTP that has to come from the same number the customer already has in
 *    their contacts. If that line is offline or out of quota we FAIL rather than
 *    quietly substituting another number, because silently sending from a
 *    different number is worse than not sending: it defeats the entire reason the
 *    caller pinned it.
 *
 *  - **Balanced.** No `from`, so pick the line with the most quota left today.
 *    This spreads load evenly, which is the whole game: 400 messages spread over
 *    8 SIMs (50 each) is invisible to a carrier; 100 through one SIM and nothing
 *    through the other seven is a flare that gets a number blocked.
 */

const log = createLogger('sim-router');

export interface Route {
  connection: Connection;
  line: SimLine;
}

/**
 * The stable identity of a SIM line: the phone plus the subscription on it. This -
 * not the phone number, which Android usually cannot read - is what SIM failover
 * records as "already tried", so a message never bounces back onto a SIM that just
 * failed it.
 */
export function lineKey(deviceId: string, subscriptionId: number): string {
  return `${deviceId}:${subscriptionId}`;
}

const NO_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

export type RouteFailure =
  | { reason: 'NO_DEVICE' }
  | { reason: 'ALL_SIMS_EXHAUSTED'; lines: number }
  | { reason: 'UNKNOWN_SENDER'; from: string }
  | { reason: 'SENDER_OFFLINE'; from: string }
  | { reason: 'SENDER_EXHAUSTED'; from: string; usedToday: number };

export type RouteResult = { ok: true; route: Route } | { ok: false; failure: RouteFailure };

/** Every line, on every connected phone, belonging to this user. */
async function candidates(userId: string): Promise<{ connection: Connection; gateway: Gateway; line: SimLine }[]> {
  const connections = gatewayRegistry.listForUser(userId);
  const out: { connection: Connection; gateway: Gateway; line: SimLine }[] = [];

  for (const connection of connections) {
    if (!connection.gatewayId) continue;

    const gateway = await repositories().gateways.findById(connection.gatewayId);

    // A device that cannot send at all - permission revoked, no SIM ready - is
    // connected but useless. Handing it a message just burns an attempt.
    if (!gateway || gateway.canSendSms === false) continue;

    for (const line of linesOf(gateway)) {
      out.push({ connection, gateway, line });
    }
  }

  return out;
}

export async function route(
  userId: string,
  from: string | null,
  options: { exclude?: ReadonlySet<string> } = {},
): Promise<RouteResult> {
  const exclude = options.exclude ?? NO_EXCLUSIONS;

  // Drop any line already tried for this message (SIM failover). With nothing
  // excluded this is the whole candidate set, exactly as before.
  const all = (await candidates(userId)).filter(
    (c) => !exclude.has(lineKey(c.gateway.deviceId, c.line.subscriptionId)),
  );

  if (all.length === 0) {
    return { ok: false, failure: { reason: 'NO_DEVICE' } };
  }

  // --- Pinned: the caller demanded a specific number ------------------------
  if (from) {
    const match = all.find((c) => c.line.phoneNumber === from);

    if (!match) {
      // Distinguish "we have never heard of that number" from "it exists but is
      // not connected" - the first is a caller bug, the second is an ops problem,
      // and telling them apart is the difference between a five-minute fix and an
      // afternoon.
      const known = await knownNumbers(userId);

      return known.has(from)
        ? { ok: false, failure: { reason: 'SENDER_OFFLINE', from } }
        : { ok: false, failure: { reason: 'UNKNOWN_SENDER', from } };
    }

    if (!hasHeadroom(match.gateway.deviceId, match.line.subscriptionId)) {
      return {
        ok: false,
        failure: {
          reason: 'SENDER_EXHAUSTED',
          from,
          usedToday: usedToday(match.gateway.deviceId, match.line.subscriptionId),
        },
      };
    }

    return { ok: true, route: { connection: match.connection, line: match.line } };
  }

  // --- Balanced: spread the load across every healthy line -------------------
  const withQuota = all.filter((c) => hasHeadroom(c.gateway.deviceId, c.line.subscriptionId));

  if (withQuota.length === 0) {
    log.error('Every SIM has hit its daily cap - refusing to send', { lines: all.length });
    return { ok: false, failure: { reason: 'ALL_SIMS_EXHAUSTED', lines: all.length } };
  }

  // Most headroom first. Not round-robin: round-robin is fair only when every SIM
  // starts the day equal, and they do not - a phone that was offline all morning
  // has a full quota while its neighbour is half spent.
  withQuota.sort(
    (a, b) =>
      remainingToday(b.gateway.deviceId, b.line.subscriptionId) -
      remainingToday(a.gateway.deviceId, a.line.subscriptionId),
  );

  const chosen = withQuota[0]!;

  return { ok: true, route: { connection: chosen.connection, line: chosen.line } };
}

/** Every number this user has ever labelled, connected or not. */
async function knownNumbers(userId: string): Promise<Set<string>> {
  const gateways = await repositories().gateways.listForUser(userId);
  const numbers = new Set<string>();

  for (const gateway of gateways) {
    for (const line of linesOf(gateway)) {
      if (line.phoneNumber) numbers.add(line.phoneNumber);
    }
  }

  return numbers;
}

/** Human-readable, actionable message for each failure. Shown to the API caller. */
export function describeFailure(failure: RouteFailure): string {
  switch (failure.reason) {
    case 'NO_DEVICE':
      return 'No gateway phone is connected. The message stays QUEUED and will be sent when one connects.';
    case 'ALL_SIMS_EXHAUSTED':
      return `All ${failure.lines} SIM(s) have hit their daily limit. Sending more today risks the carrier blocking them.`;
    case 'UNKNOWN_SENDER':
      return `No SIM is labelled ${failure.from}. Label it in the gateway app, on the phone that holds that SIM.`;
    case 'SENDER_OFFLINE':
      return `The phone holding ${failure.from} is not connected.`;
    case 'SENDER_EXHAUSTED':
      return `${failure.from} has already sent ${failure.usedToday} SMS parts today and has hit its daily limit.`;
  }
}
