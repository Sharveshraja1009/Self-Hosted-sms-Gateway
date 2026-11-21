import { ErrorCode, ServiceUnavailableError, TooManyRequestsError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { AuditAction } from '../../domain/audit.js';
import { type Message, segment } from '../../domain/message.js';
import { repositories } from '../../repositories/index.js';
import { auditContextFrom, auditService } from '../audit/audit.service.js';
import { dispatchTo } from '../gateway/gateway.socket.js';
import { consume } from './sim-quota.js';
import { describeFailure, route } from './sim-router.js';

/**
 * The send path.
 *
 * Accepting a message and *delivering* it are decoupled: `send()` always persists
 * first, then tries to hand the message to a SIM. If no phone is connected the
 * message stays QUEUED and the call still succeeds with a 202 - because rejecting
 * it would force every integration to build its own retry buffer for the
 * perfectly ordinary case of "the phone is in a lift".
 *
 * Running out of *quota*, though, is a different animal, and it does NOT queue
 * silently. A SIM at its daily cap will still be at its cap in an hour, and
 * pushing past it is what gets a number blacklisted - so the caller is told, with
 * a 429, rather than watching a message sit in QUEUED forever.
 */

const log = createLogger('sms');

export interface SendResult {
  message: Message;
  /** False when the message was accepted but is waiting for a device to appear. */
  dispatched: boolean;
}

export const smsService = {
  async send(params: {
    userId: string;
    recipient: string;
    body: string;
    clientRef: string | null;
    /** Pin the sending number. Omit to let the router pick the least-used SIM. */
    from: string | null;
  }): Promise<SendResult> {
    // Segmentation at the boundary, once. The carrier bills per part - and, more
    // to the point, counts parts against the SIM's daily cap - so this number is
    // what the quota is spent in.
    const { partCount, isUnicode } = segment(params.body);

    const message = await repositories().messages.create({
      userId: params.userId,
      recipient: params.recipient,
      body: params.body,
      partCount,
      isUnicode,
      clientRef: params.clientRef,
      // Remembered so failover can respect a pin: a message sent "from" a specific
      // number must never fail over to a different SIM.
      pinnedFrom: params.from,
    });

    void auditService.success(AuditAction.SMS_QUEUED, params.userId, auditContextFrom(), {
      messageId: message.id,
      recipient: params.recipient,
      partCount,
    });

    const result = await route(params.userId, params.from);

    if (!result.ok) {
      const detail = describeFailure(result.failure);

      // No phone connected is NOT an error - the backlog exists precisely for this,
      // and the next device to register drains it.
      if (result.failure.reason === 'NO_DEVICE') {
        log.info('No gateway online - message left QUEUED', { messageId: message.id });
        return { message, dispatched: false };
      }

      // Every other failure is terminal for this message. Leaving it QUEUED would
      // be a lie: a SIM at its cap does not recover in a minute, and an unknown
      // sender number never will.
      await repositories().messages.update(message.id, {
        status: 'FAILED',
        failedAt: new Date(),
        errorCode: result.failure.reason,
        errorMessage: detail,
      });

      log.warn('Could not route message', { messageId: message.id, reason: result.failure.reason });

      if (result.failure.reason === 'ALL_SIMS_EXHAUSTED' || result.failure.reason === 'SENDER_EXHAUSTED') {
        void auditService.failure(AuditAction.DAILY_LIMIT_REACHED, params.userId, auditContextFrom(), {
          messageId: message.id,
          reason: result.failure.reason,
        });

        throw new TooManyRequestsError(detail, { code: ErrorCode.DAILY_LIMIT_EXCEEDED });
      }

      throw new ServiceUnavailableError(detail, ErrorCode.NO_GATEWAY_AVAILABLE);
    }

    const { connection, line } = result.route;

    // Spend the quota BEFORE the write, not after the phone reports success.
    // Between dispatch and the SENT receipt there is a window of seconds; a burst
    // of sends inside that window would all see the old count and every one of
    // them would be allowed. Counting optimistically can overstate usage if a
    // send fails - which errs toward protecting the SIM, and that is the correct
    // direction to be wrong in.
    consume(connection.deviceId, line.subscriptionId, message.partCount);

    await dispatchTo(connection, line, message);

    log.info('Message dispatched', {
      messageId: message.id,
      deviceId: connection.deviceId,
      sim: line.slot,
      from: line.phoneNumber,
      partCount,
    });

    // Re-read: dispatchTo moved it to SENDING and stamped the sender, and the
    // caller should see the row as it is, not our guess at it.
    const dispatched = await repositories().messages.findById(message.id);

    return { message: dispatched ?? message, dispatched: true };
  },

  async findForUser(userId: string, messageId: string): Promise<Message | null> {
    const message = await repositories().messages.findById(messageId);

    // Ownership, not just existence. Returning null (-> 404) rather than 403 for
    // someone else's message is deliberate: a 403 would confirm the id exists,
    // turning an id guess into an enumeration oracle.
    if (!message || message.userId !== userId) return null;

    return message;
  },

  async listForUser(
    userId: string,
    query: { page: number; limit: number; status?: Message['status']; search?: string },
  ) {
    return repositories().messages.list({ userId, ...query });
  },
};
