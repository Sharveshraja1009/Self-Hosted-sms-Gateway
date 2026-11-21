import type { Request, Response } from 'express';

import { NotFoundError, UnauthorizedError } from '../../core/errors.js';
import { buildPaginationMeta, sendSuccess } from '../../core/http-response.js';
import { toPublicMessage } from '../../domain/message.js';
import { validatedBody, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { smsService } from './sms.service.js';
import type { ListMessagesInput, MessageIdInput, SendSmsInput } from './sms.schemas.js';

/**
 * HTTP adapter for the SMS module.
 *
 * Input arrives pre-validated on `req.validated`, so nothing here re-checks
 * shapes. Unwrap, delegate, respond. Express 5 forwards a rejected promise from
 * an async handler to the error middleware on its own, which is why there is no
 * try/catch in sight.
 */

/** `authenticate` guarantees req.user, but TypeScript cannot see that across middleware. */
function requireUser(req: Request): { id: string } {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }
  return req.user;
}

export const smsController = {
  /**
   * **202 Accepted**, not 201 Created - and that is not pedantry.
   *
   * The message has been accepted for delivery; nothing has left the radio yet,
   * and it may still fail. A 201 would tell an integrator "done" at the precise
   * moment the work has not started. They poll GET /api/sms/:id to learn what
   * actually happened.
   */
  send: async (req: Request, res: Response): Promise<void> => {
    const { to, body, from, clientRef } = validatedBody<SendSmsInput>(req);

    const { message, dispatched } = await smsService.send({
      userId: requireUser(req).id,
      recipient: to,
      body,
      from: from ?? null,
      clientRef: clientRef ?? null,
    });

    // `dispatched` is the one thing a caller cannot infer from the message itself:
    // was there a phone to hand it to, or is it waiting for one to appear?
    sendSuccess(res, toPublicMessage(message), 202, { dispatched });
  },

  get: async (req: Request, res: Response): Promise<void> => {
    const { id } = validatedParams<MessageIdInput>(req);

    const message = await smsService.findForUser(requireUser(req).id, id);

    if (!message) {
      throw new NotFoundError('Message');
    }

    sendSuccess(res, toPublicMessage(message));
  },

  list: async (req: Request, res: Response): Promise<void> => {
    const { page, limit, status, search } = validatedQuery<ListMessagesInput>(req);

    const { items, total } = await smsService.listForUser(requireUser(req).id, {
      page,
      limit,
      status,
      search,
    });

    sendSuccess(res, items.map(toPublicMessage), 200, buildPaginationMeta(page, limit, total));
  },
};
