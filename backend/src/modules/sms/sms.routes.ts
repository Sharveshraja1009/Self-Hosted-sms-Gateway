import { Router } from 'express';

import { ApiKeyScope } from '../../domain/user.js';
import { authenticate, requireScope } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { smsController } from './sms.controller.js';
import { listMessagesSchema, messageIdSchema, sendSmsSchema } from './sms.schemas.js';

/**
 * SMS routes.
 *
 * The scope guards are the point of the whole API-key design. A customer's server
 * gets a key scoped to `sms:send` and can do exactly that; it cannot read the
 * account's message history, and it cannot impersonate a handset on the gateway
 * WebSocket. A human with a JWT is governed by their role instead, so these
 * guards do not bite them - see the note in requireScope().
 */
export const smsRouter: Router = Router();

smsRouter.post(
  '/send',
  authenticate,
  requireScope(ApiKeyScope.SMS_SEND),
  validate({ body: sendSmsSchema }),
  smsController.send,
);

smsRouter.get(
  '/',
  authenticate,
  requireScope(ApiKeyScope.SMS_READ),
  validate({ query: listMessagesSchema }),
  smsController.list,
);

smsRouter.get(
  '/:id',
  authenticate,
  requireScope(ApiKeyScope.SMS_READ),
  validate({ params: messageIdSchema }),
  smsController.get,
);
