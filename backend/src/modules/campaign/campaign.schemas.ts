import { z } from 'zod';

import { env } from '../../config/env.js';
import { MAX_VARIABLES } from '../../domain/campaign.js';

/**
 * Input schemas for campaigns.
 *
 * The recipient list arrives as one pasted blob of text, not a JSON array,
 * because that is how an operator actually has the numbers - a column copied out
 * of a spreadsheet, one per line. The service parses, normalises and
 * de-duplicates it (see domain/campaign.ts); the schema only guards the coarse
 * shape and length so a 5MB paste is rejected before it reaches that code.
 */

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * One recipient from a spreadsheet upload: a number, plus the value of every
 * column the operator mapped to a template variable.
 *
 * Keys and values are normalised, truncated and de-duplicated downstream (see
 * domain/campaign.ts), so this only guards the coarse shape - enough that a
 * malformed or oversized upload is refused before it reaches that code. The value
 * ceiling is deliberately looser than the send-time cap: a long cell is shortened
 * when it is merged, not rejected on arrival.
 *
 * `name` stays as its own field for the single-column personalisation this grew
 * out of; it is folded into `vars.name` by the parser.
 */
const recipientRowSchema = z.object({
  phone: z.string().trim().min(1).max(32),
  name: z.string().trim().max(120).nullish(),
  vars: z
    .record(z.string().trim().min(1).max(40), z.string().trim().max(400))
    .refine((v) => Object.keys(v).length <= MAX_VARIABLES, {
      message: `A recipient may carry at most ${MAX_VARIABLES} variables`,
    })
    .nullish(),
});

export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the campaign a name').max(120),

    body: z.string().min(1, 'Message body cannot be empty').max(1600),

    /** Pin the sending SIM, or omit to let the router balance across every connected SIM. */
    from: z
      .string()
      .trim()
      .transform((value) => value.replace(/[\s()-]/g, ''))
      .pipe(z.string().regex(E164, 'The "from" number must be E.164, e.g. +919876543210'))
      .nullish(),

    /** The raw pasted numbers (no names). Parsed downstream; capped so a runaway paste is refused early. */
    recipients: z.string().max(1_000_000).optional().default(''),

    /**
     * Rows from an uploaded file - a number and its template variables, one entry
     * per mapped column. This is what makes `{name}`, `{amount}`, `{due_date}` and
     * anything else in the body resolve per recipient. The paste box (`recipients`)
     * and this list are merged in the service; a campaign may use either or both,
     * though only these rows can carry variables.
     */
    recipientRows: z.array(recipientRowSchema).max(100_000).optional().default([]),

    /** Seconds between sends. Clamped to the configured floor in the service - the schema is lenient. */
    intervalSeconds: z.coerce.number().int().min(1).max(3_600).optional(),

    /**
     * Sending window in whole hours of the server's local day (0-23 start, 1-24
     * end). Only sends when the local hour is within [start, end) - e.g. 9 and 18
     * for business hours. Defaults to the server's configured window. Set 0 and 24
     * to send around the clock.
     */
    windowStartHour: z.coerce.number().int().min(0).max(23).optional(),
    windowEndHour: z.coerce.number().int().min(1).max(24).optional(),

    /** The dialling code prefixed to bare local numbers. Defaults to the server's configured country. */
    countryCode: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{0,3}$/, 'Country code must look like "+91"')
      .default(env.CAMPAIGN_DEFAULT_COUNTRY_CODE),

    /** Start sending immediately on create. Default true - the usual "upload and go". */
    start: z.boolean().default(true),
  })
  .refine((v) => v.recipients.trim().length > 0 || v.recipientRows.length > 0, {
    message: 'Add at least one recipient — paste numbers, or upload a file.',
    path: ['recipients'],
  });

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const campaignIdSchema = z.object({
  id: z.string().uuid('Not a valid campaign id'),
});

export type CampaignIdInput = z.infer<typeof campaignIdSchema>;

export const listCampaignsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
});

export type ListCampaignsInput = z.infer<typeof listCampaignsSchema>;
