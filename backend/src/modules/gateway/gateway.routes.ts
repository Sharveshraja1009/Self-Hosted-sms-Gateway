import { Router } from 'express';
import type { Request, Response } from 'express';

import { env } from '../../config/env.js';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../core/errors.js';
import { sendSuccess } from '../../core/http-response.js';
import { localDateString, localDayRange } from '../../core/time.js';
import { type Gateway, linesOf, type SimLine, toPublicGateway } from '../../domain/gateway.js';
import { authenticate } from '../../middleware/authenticate.js';
import { repositories } from '../../repositories/index.js';
import type { LineDailyStats } from '../../repositories/types.js';
import { usedToday } from '../sms/sim-quota.js';
import { gatewayRegistry } from './gateway.registry.js';
import { requestCallLog, requestDeviceSms } from './gateway.socket.js';

/**
 * Gateway (device) routes.
 *
 * The list endpoint merges two sources on purpose: the durable `Gateway` record
 * from MongoDB, and whether this process is *currently* holding a socket to it.
 * The database says what a device is; the registry says whether it is reachable
 * from here, right now. Reporting only the stored status would show a phone as
 * ONLINE for as long as it took the offline sweeper to notice it was gone - and
 * "is my phone actually connected?" is the one question this endpoint exists to
 * answer.
 */
export const gatewayRouter: Router = Router();

/**
 * The day whose per-SIM figures the caller wants, as a LOCAL calendar date.
 *
 * Defaults to today. Accepting a date at all is what makes the panel a record
 * rather than a live gauge: "how many did this SIM send last Tuesday" is the
 * question you ask when planning tomorrow's campaign.
 */
function requestedDay(req: Request): string {
  const raw = req.query.date;

  if (raw === undefined) return localDateString();

  // Express types a query value as string | string[] | object | object[] - a
  // client can send `?date[$gt]=` and hand us an object. Anything that is not a
  // plain string falls through to the format check below and is rejected there.
  const day = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : '';

  // Validated rather than passed through: this string is turned into a date range,
  // and a malformed one would silently widen the window instead of erroring.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new BadRequestError('`date` must be a calendar date in YYYY-MM-DD form.');
  }

  return day;
}

/** A SIM line's stable identity, as used to bucket the day's stats. */
function lineId(deviceId: string, subscriptionId: number): string {
  return `${deviceId}:${subscriptionId}`;
}

/**
 * Decide which line owns each pre-upgrade message row.
 *
 * Rows written before the sending line was stamped carry only a `senderNumber` -
 * an operator-typed label. Dropping them would make every send from before this
 * shipped vanish from the totals, which looks exactly like the counter being
 * broken again. But attributing them to *every* line with that label is worse:
 * this project's own fleet has one number labelled on two different handsets, and
 * that would count its history twice in the fleet total.
 *
 * So each legacy number is given to exactly ONE line: the one on the gateway the
 * message says it went through if that record still exists, otherwise the first
 * line claiming that label in a stable order. Not perfect attribution - it cannot
 * be, the information is genuinely not there - but it is stable across refreshes
 * and it never double-counts.
 */
function resolveLegacyOwners(gateways: Gateway[], rows: LineDailyStats[]): Map<string, string> {
  const owner = new Map<string, string>();

  // Stable order, so the same number lands on the same card every refresh rather
  // than hopping between two phones as Mongo's result order shifts.
  const ordered = [...gateways].sort((a, b) => a.id.localeCompare(b.id));

  for (const row of rows) {
    if (row.deviceId !== null && row.subscriptionId !== null) continue;
    if (!row.senderNumber || owner.has(row.senderNumber)) continue;

    // First choice: the phone the message actually went through, if that record
    // has not since been deleted and re-registered under a new id.
    const byGateway = ordered.find((g) => g.id === row.gatewayId);
    const candidates = byGateway ? [byGateway, ...ordered] : ordered;

    for (const gateway of candidates) {
      const line = linesOf(gateway).find((l) => l.phoneNumber === row.senderNumber);

      if (line) {
        owner.set(row.senderNumber, lineId(gateway.deviceId, line.subscriptionId));
        break;
      }
    }
  }

  return owner;
}

/** Every stats row belonging to one SIM line, modern and legacy alike. */
function statsForLine(
  rows: LineDailyStats[],
  gateway: Gateway,
  line: SimLine,
  legacyOwners: Map<string, string>,
): LineDailyStats[] {
  const id = lineId(gateway.deviceId, line.subscriptionId);

  return rows.filter((row) => {
    if (row.deviceId !== null && row.subscriptionId !== null) {
      return lineId(row.deviceId, row.subscriptionId) === id;
    }

    return row.senderNumber !== null && legacyOwners.get(row.senderNumber) === id;
  });
}

const list = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }

  const day = requestedDay(req);
  const { from, to } = localDayRange(day);

  const gateways = await repositories().gateways.listForUser(req.user.id);
  const live = new Set(gatewayRegistry.listForUser(req.user.id).map((connection) => connection.deviceId));

  // One aggregation for the whole fleet, not one per SIM: a user with eight lines
  // would otherwise fire eight queries every time the panel auto-refreshes.
  const stats = await repositories().messages.dailyLineStats(req.user.id, from, to);
  const legacyOwners = resolveLegacyOwners(gateways, stats);

  sendSuccess(res, {
    date: day,
    dailyLimit: env.SIM_DAILY_SMS_LIMIT,
    gateways: gateways.map((gateway) => {
      const publicGateway = toPublicGateway(gateway);

      return {
        ...publicGateway,
        /** Is a socket to this device open on THIS process, at this instant? */
        connected: live.has(gateway.deviceId),
        // Each line annotated with what it actually did that day, so an operator
        // can see a SIM nearing its cap BEFORE the carrier does - and can tell a
        // quiet SIM from one whose every send is failing.
        sims: linesOf(gateway).map((line) => {
          const rows = statsForLine(stats, gateway, line, legacyOwners);
          const sum = (pick: (row: LineDailyStats) => number): number => rows.reduce((n, row) => n + pick(row), 0);

          const parts = sum((row) => row.parts);
          // The live counter and the message history should agree; when they do
          // not, trust whichever is HIGHER. The counter is spent optimistically at
          // dispatch and the row is written a moment later, so during that window
          // the counter leads - and under-reporting usage is the one direction
          // this number must never be wrong in.
          const live = usedToday(gateway.deviceId, line.subscriptionId);

          return {
            ...line,
            /** SMS parts spent against the cap. */
            usedToday: day === localDateString() ? Math.max(parts, live) : parts,
            dailyLimit: env.SIM_DAILY_SMS_LIMIT,
            /** Whole messages, by outcome. These are what an operator reads. */
            sentToday: sum((row) => row.sent),
            deliveredToday: sum((row) => row.delivered),
            failedToday: sum((row) => row.failed),
            pendingToday: sum((row) => row.pending),
            attemptedToday: sum((row) => row.attempted),
          };
        }),
      };
    }),
  });
};

/**
 * Remove a device record.
 *
 * The one guard that matters: a *currently connected* phone cannot be deleted. It
 * would re-register on its very next heartbeat anyway, so deleting it is at best a
 * no-op and at worst deletes the phone you are actively using. Deletion is for
 * clearing out a stale row - typically a phone that reinstalled the app and now
 * has a second, orphaned record under a new deviceId. Stop the app on the phone
 * (or wait for it to go offline), then remove it.
 */
const remove = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }

  // Express 5 types a param as `string | string[]`; a route with a single `:id`
  // only ever yields a string, but normalise so the types are honest.
  const id = Array.isArray(req.params.id) ? (req.params.id[0] ?? '') : (req.params.id ?? '');
  const gateway = await repositories().gateways.findById(id);

  // Ownership, not just existence: a 404 for someone else's device id reveals
  // nothing, whereas a 403 would confirm the id is real.
  if (!gateway || gateway.userId !== req.user.id) {
    throw new NotFoundError('Gateway');
  }

  const live = gatewayRegistry.listForUser(req.user.id).some((c) => c.deviceId === gateway.deviceId);
  if (live) {
    throw new ConflictError(
      'This phone is currently connected. Stop the gateway app on it (or wait for it to go offline), then remove it.',
    );
  }

  await repositories().gateways.delete(gateway.id);

  sendSuccess(res, { id: gateway.id, deleted: true });
};

/**
 * Fetch a phone's call log or stored SMS, live, over its open socket.
 *
 * These read data that lives ONLY on the handset - its call history and its SMS
 * inbox - so they are answered by the phone itself, on demand, not from any
 * server-side store. The device must be connected (it is the only thing that has
 * the data) and must have granted the app READ_CALL_LOG / READ_SMS; when it has
 * not, the phone replies `granted: false` and the panel explains rather than
 * showing an empty list.
 */
function ownedGatewayId(req: Request): string {
  return Array.isArray(req.params.id) ? (req.params.id[0] ?? '') : (req.params.id ?? '');
}

const callLog = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new UnauthorizedError('Authentication required');

  const gateway = await repositories().gateways.findById(ownedGatewayId(req));
  if (!gateway || gateway.userId !== req.user.id) throw new NotFoundError('Gateway');

  const connection = gatewayRegistry.get(gateway.deviceId);
  if (!connection || connection.userId !== req.user.id) {
    throw new ConflictError('This phone is offline. Its call log can only be read while it is connected.');
  }

  const reply = await requestCallLog(connection);
  sendSuccess(res, { granted: reply.granted, entries: reply.entries });
};

const deviceSms = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new UnauthorizedError('Authentication required');

  const gateway = await repositories().gateways.findById(ownedGatewayId(req));
  if (!gateway || gateway.userId !== req.user.id) throw new NotFoundError('Gateway');

  const connection = gatewayRegistry.get(gateway.deviceId);
  if (!connection || connection.userId !== req.user.id) {
    throw new ConflictError('This phone is offline. Its messages can only be read while it is connected.');
  }

  const reply = await requestDeviceSms(connection);
  sendSuccess(res, { granted: reply.granted, messages: reply.messages });
};

gatewayRouter.get('/', authenticate, list);
gatewayRouter.delete('/:id', authenticate, remove);
gatewayRouter.get('/:id/call-log', authenticate, callLog);
gatewayRouter.get('/:id/sms', authenticate, deviceSms);
