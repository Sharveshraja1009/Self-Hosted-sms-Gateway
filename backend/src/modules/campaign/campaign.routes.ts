import { Router } from 'express';
import multer from 'multer';

import { ApiKeyScope } from '../../domain/user.js';
import { authenticate, requireScope } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { campaignController } from './campaign.controller.js';
import { campaignIdSchema, createCampaignSchema, listCampaignsSchema } from './campaign.schemas.js';

/**
 * A recipients file is held in memory (never written to disk) and parsed inline,
 * then discarded - there is nothing to store, only numbers to extract. 5 MB is a
 * generous ceiling: a spreadsheet of tens of thousands of numbers is well under
 * it, and it caps what a single request can make the process buffer.
 */
const uploadRecipients = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/**
 * Campaign routes - the bulk / promotional sending surface.
 *
 * Creating and controlling a campaign is *sending*, so it is guarded by
 * `sms:send`; listing and inspecting one is *reading*, guarded by `sms:read`. A
 * human admin driving the panel carries a JWT and is governed by their role, so
 * these scope guards do not bite them - only machine keys are scoped.
 */
export const campaignRouter: Router = Router();

campaignRouter.post(
  '/',
  authenticate,
  requireScope(ApiKeyScope.SMS_SEND),
  validate({ body: createCampaignSchema }),
  campaignController.create,
);

campaignRouter.get(
  '/',
  authenticate,
  requireScope(ApiKeyScope.SMS_READ),
  validate({ query: listCampaignsSchema }),
  campaignController.list,
);

// Parse an uploaded spreadsheet into a list of numbers. Guarded by sms:send (it
// feeds a send), and separate from create() so the operator reviews the extracted
// numbers before anything is queued.
campaignRouter.post(
  '/parse-recipients',
  authenticate,
  requireScope(ApiKeyScope.SMS_SEND),
  uploadRecipients.single('file'),
  campaignController.parseRecipients,
);

campaignRouter.get(
  '/:id',
  authenticate,
  requireScope(ApiKeyScope.SMS_READ),
  validate({ params: campaignIdSchema }),
  campaignController.get,
);

campaignRouter.post(
  '/:id/start',
  authenticate,
  requireScope(ApiKeyScope.SMS_SEND),
  validate({ params: campaignIdSchema }),
  campaignController.start,
);

campaignRouter.post(
  '/:id/pause',
  authenticate,
  requireScope(ApiKeyScope.SMS_SEND),
  validate({ params: campaignIdSchema }),
  campaignController.pause,
);

campaignRouter.post(
  '/:id/cancel',
  authenticate,
  requireScope(ApiKeyScope.SMS_SEND),
  validate({ params: campaignIdSchema }),
  campaignController.cancel,
);
