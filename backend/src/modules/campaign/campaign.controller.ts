import type { Request, Response } from 'express';

import { env } from '../../config/env.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../core/errors.js';
import { buildPaginationMeta, sendSuccess } from '../../core/http-response.js';
import { localHour } from '../../core/time.js';
import { toPublicCampaign } from '../../domain/campaign.js';
import { validatedBody, validatedParams, validatedQuery } from '../../middleware/validate.js';
import { campaignService } from './campaign.service.js';
import type { CampaignIdInput, CreateCampaignInput, ListCampaignsInput } from './campaign.schemas.js';
import { extractRecipientRowsFromFile, extractRecipientTableFromFile } from './recipient-file.js';

/**
 * HTTP adapter for campaigns. Input is pre-validated on `req.validated`; unwrap,
 * delegate, respond. Express 5 forwards async rejections to the error middleware,
 * so there is no try/catch here.
 */

function requireUser(req: Request): { id: string } {
  if (!req.user) {
    throw new UnauthorizedError('Authentication required');
  }
  return req.user;
}

export const campaignController = {
  /**
   * **202 Accepted** when started: the campaign is under way but nothing has been
   * delivered yet - the runner sends over the following minutes. The `meta` block
   * carries the parse summary (what was skipped as invalid or duplicate) so the
   * operator can reconcile the count they pasted against the count that will send.
   */
  create: async (req: Request, res: Response): Promise<void> => {
    const input = validatedBody<CreateCampaignInput>(req);

    const { campaign, invalid, duplicates, variables, incomplete } = await campaignService.create({
      userId: requireUser(req).id,
      name: input.name,
      body: input.body,
      from: input.from ?? null,
      recipients: input.recipients,
      recipientRows: input.recipientRows,
      intervalSeconds: input.intervalSeconds,
      windowStartHour: input.windowStartHour,
      windowEndHour: input.windowEndHour,
      countryCode: input.countryCode,
      start: input.start,
    });

    sendSuccess(
      res,
      toPublicCampaign(campaign, { includeRecipients: true, nowHour: localHour() }),
      input.start ? 202 : 201,
      {
        accepted: campaign.recipients.length,
        invalid,
        invalidCount: invalid.length,
        duplicates,
        // What the body actually merges, and how many rows cannot supply all of it -
        // the operator sees both before the first message goes out.
        variables,
        incomplete,
      },
    );
  },

  list: async (req: Request, res: Response): Promise<void> => {
    const { page, limit, status } = validatedQuery<ListCampaignsInput>(req);

    const { items, total } = await campaignService.list(requireUser(req).id, { page, limit, status });

    // One clock reading for the whole page, so every card judges "within window"
    // against the same instant.
    const nowHour = localHour();
    sendSuccess(
      res,
      items.map((c) => toPublicCampaign(c, { nowHour })),
      200,
      buildPaginationMeta(page, limit, total),
    );
  },

  get: async (req: Request, res: Response): Promise<void> => {
    const { id } = validatedParams<CampaignIdInput>(req);

    const campaign = await campaignService.findForUser(requireUser(req).id, id);
    if (!campaign) {
      throw new NotFoundError('Campaign');
    }

    sendSuccess(res, toPublicCampaign(campaign, { includeRecipients: true, nowHour: localHour() }));
  },

  start: async (req: Request, res: Response): Promise<void> => {
    const { id } = validatedParams<CampaignIdInput>(req);
    const campaign = await campaignService.start(requireUser(req).id, id);
    sendSuccess(res, toPublicCampaign(campaign, { nowHour: localHour() }));
  },

  pause: async (req: Request, res: Response): Promise<void> => {
    const { id } = validatedParams<CampaignIdInput>(req);
    const campaign = await campaignService.pause(requireUser(req).id, id);
    sendSuccess(res, toPublicCampaign(campaign, { nowHour: localHour() }));
  },

  cancel: async (req: Request, res: Response): Promise<void> => {
    const { id } = validatedParams<CampaignIdInput>(req);
    const campaign = await campaignService.cancel(requireUser(req).id, id);
    sendSuccess(res, toPublicCampaign(campaign, { nowHour: localHour() }));
  },

  /**
   * Read an uploaded spreadsheet (.xlsx / .csv) into a table the operator can map.
   *
   * This does NOT create a campaign. It returns the sheet as it is - every column
   * with its header, a sample value and our guess at its role, plus every data row -
   * so the panel can let the operator decide which column is the phone number and
   * which columns feed which `{variables}` in the message. That decision is theirs
   * on purpose: mapping the wrong column texts a thousand people the wrong figure,
   * and no heuristic should be trusted with that.
   *
   * The campaign is then created through the normal path, where the country-code
   * default, de-duplication and E.164 validation live. Parsing and sending stay
   * separate so the operator always sees what will be sent before anything queues.
   *
   * `recipients` / `count` / `namedCount` are the older name+number view of the same
   * file, kept so a client written before column mapping keeps working.
   */
  parseRecipients: async (req: Request, res: Response): Promise<void> => {
    requireUser(req);

    // `req.file` is populated by multer's upload.single('file') middleware.
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      throw new BadRequestError('No file was uploaded. Attach a .xlsx or .csv file in the "file" field.');
    }

    // Capped at what a campaign may target: the whole table crosses the wire, and a
    // sheet with more rows than can ever be sent should not be shipped to a browser.
    const table = await extractRecipientTableFromFile(file.buffer, file.originalname, {
      maxRows: env.CAMPAIGN_MAX_RECIPIENTS,
    });

    // The legacy view, derived from the table we already parsed rather than reading
    // the file a second time. Only the odd layout where no column looked like phone
    // numbers falls back to the loose whole-sheet scan.
    const nameColumn = table.columns.find((c) => c.role === 'variable' && c.key.includes('name'));
    const recipients =
      table.phoneColumn >= 0
        ? table.rows.map((row) => ({
            phone: row[table.phoneColumn] ?? '',
            name: (nameColumn ? row[nameColumn.index] : null) || null,
          }))
        : await extractRecipientRowsFromFile(file.buffer, file.originalname);

    sendSuccess(res, {
      filename: file.originalname,
      columns: table.columns,
      rows: table.rows,
      headerPresent: table.headerPresent,
      phoneColumn: table.phoneColumn,
      skipped: table.skipped,
      truncated: table.truncated,
      recipients,
      count: recipients.length,
      namedCount: recipients.filter((r) => r.name).length,
    });
  },
};
