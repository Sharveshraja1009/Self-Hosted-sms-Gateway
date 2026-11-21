import { z } from 'zod';

import { ApiKeyScope } from '../../domain/user.js';

/**
 * The auth module's input contracts.
 *
 * Schemas live beside the routes they guard and are exported as types, so the
 * service signature and the HTTP contract cannot drift apart - change the schema
 * and the service stops compiling.
 */

/**
 * Password policy.
 *
 * Length is the only requirement that reliably survives contact with reality:
 * composition rules ("one uppercase, one symbol") push users toward `Passw0rd!`
 * and measurably reduce entropy. NIST SP 800-63B agrees - so we set a real floor
 * (10), a hard ceiling (bcrypt silently truncates past 72 bytes, so anything
 * longer creates a false sense of security), and block nothing else.
 */
const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters (bcrypt truncates beyond this)');

/** Normalise before validating: "  Alice@Example.COM " and "alice@example.com" are one account. */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .pipe(z.email('Must be a valid email address'));

export const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().min(1, 'Name is required').max(120),
});

export const loginSchema = z.object({
  email,
  // Not `password` - a login must accept whatever the user set previously, even
  // if the policy has since tightened. Only registration enforces the new floor.
  password: z.string().min(1, 'Password is required').max(72),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const logoutSchema = refreshSchema;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'The new password must be different from the current one',
    path: ['newPassword'],
  });

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name so you can recognise it later').max(80),
  scopes: z
    .array(z.enum(ApiKeyScope))
    .min(1, 'An API key needs at least one scope')
    // Least privilege that is still useful: send, but do not read history.
    .default([ApiKeyScope.SMS_SEND]),
  /** ISO-8601 timestamp. Omit (or null) for a key that never expires. */
  expiresAt: z.coerce
    .date()
    // Checked against the time of the *request*, not the time the module loaded -
    // a long-lived process would otherwise drift into accepting past dates.
    .refine((date) => date.getTime() > Date.now(), 'Expiry must be in the future')
    .nullish(),
});

export const apiKeyIdSchema = z.object({
  id: z.uuid('Not a valid API key id'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ApiKeyIdParams = z.infer<typeof apiKeyIdSchema>;
