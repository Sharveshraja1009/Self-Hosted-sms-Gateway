import { z } from 'zod';

/**
 * Input schemas for the send path.
 *
 * The E.164 rule is the important one. A recipient is not "a phone number" - it
 * is an internationally-routable address, and the SIM will silently do the wrong
 * thing with anything else. `09876543210` is a valid *local* number in India and
 * means nothing to a gateway that might be roaming; `+919876543210` means exactly
 * one handset on earth. We refuse the ambiguous form rather than guessing a
 * country code, because guessing wrong sends someone else's OTP to a stranger.
 */

const E164 = /^\+[1-9]\d{7,14}$/;

export const sendSmsSchema = z.object({
  to: z
    .string()
    .trim()
    // Strip the formatting humans paste in - spaces, dashes, brackets - before
    // validating. We are strict about the *shape*, not about typing style.
    .transform((value) => value.replace(/[\s()-]/g, ''))
    .pipe(
      z
        .string()
        .regex(E164, 'Must be an E.164 number, e.g. +919876543210 (leading +, country code, no spaces)'),
    ),

  // 1600 chars is ~10 SMS parts in GSM-7. Not a technical limit - a guardrail.
  // A 50KB body would be split into 300 parts and silently cost a fortune.
  body: z.string().min(1, 'Message body cannot be empty').max(1600),

  /**
   * Pin the SENDING number. Optional.
   *
   * Omit it and the server auto-picks the least-busy SIM across every connected
   * phone - which is what you want for most traffic, because it spreads load and
   * keeps any one SIM off a carrier's radar. Set it when a specific number *must*
   * send - an OTP that has to come from the number a customer already recognises -
   * and the server will fail rather than silently substitute a different one.
   */
  from: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s()-]/g, ''))
    .pipe(z.string().regex(E164, 'The "from" number must be E.164, e.g. +919876543210'))
    .nullish(),

  /** The caller's own reference, echoed back so they can reconcile against their system. */
  clientRef: z.string().trim().min(1).max(128).nullish(),
});

export type SendSmsInput = z.infer<typeof sendSmsSchema>;

export const messageIdSchema = z.object({
  id: z.string().uuid('Not a valid message id'),
});

export type MessageIdInput = z.infer<typeof messageIdSchema>;

export const listMessagesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Filter to one lifecycle state. Omit for all. */
  status: z.enum(['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'CANCELLED']).optional(),
  /** Free-text match against recipient, sender number and body. */
  search: z.string().trim().min(1).max(100).optional(),
});

export type ListMessagesInput = z.infer<typeof listMessagesSchema>;
