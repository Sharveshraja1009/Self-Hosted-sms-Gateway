import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Fail-fast environment configuration.
 *
 * The whole process depends on a handful of external facts (which port, which
 * database, which secret). Reading `process.env.FOO` ad-hoc across the codebase
 * means a typo or a missing value only explodes at 3am when the code path is
 * finally hit. Instead we parse and validate everything exactly once, at boot,
 * and export a typed, frozen object. A misconfigured server never starts.
 */

loadDotenv();

/** Accepts "true"/"1"/"yes"/"on" (case-insensitive) as true; anything else false. */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()),
  );

/** "a,b , c" -> ["a", "b", "c"] */
const csvList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)));

/** A duration string accepted by jsonwebtoken, e.g. "15m", "30d", "3600" (seconds). */
const jwtDuration = z.string().regex(/^\d+(ms|s|m|h|d|w|y)?$/, 'must look like "15m", "30d" or "3600"');

const envSchema = z.object({
  // --- Application ---------------------------------------------------------
  APP_NAME: z.string().min(1).default('sms-gateway'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  API_PREFIX: z
    .string()
    .startsWith('/', 'API_PREFIX must start with "/"')
    .default('/api'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  CORS_ORIGINS: csvList.default(['http://localhost:5173']),
  BODY_LIMIT: z.string().min(2).default('1mb'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // --- Logging -------------------------------------------------------------
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  LOG_DIR: z.string().min(1).default('logs'),
  LOG_TO_FILE: booleanish.default(true),

  // --- Datastores ----------------------------------------------------------
  MONGODB_URI: z
    .string()
    .min(1)
    .startsWith('mongodb', 'MONGODB_URI must start with mongodb:// or mongodb+srv://'),
  /**
   * Kept separate from the URI rather than read from its path. It lets the test
   * suite point at `smsgw_test` by overriding one variable, and it means a URI
   * that forgets its trailing database name fails loudly here instead of
   * silently writing everything into Mongo's default `test` database.
   */
  MONGODB_DB: z.string().min(1).default('smsgw'),
  REDIS_URL: z.string().min(1).startsWith('redis', 'REDIS_URL must start with redis:// or rediss://'),

  // --- Auth ----------------------------------------------------------------
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: jwtDuration.default('15m'),
  JWT_REFRESH_TTL: jwtDuration.default('30d'),
  GATEWAY_JWT_TTL: jwtDuration.default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // --- Rate limiting -------------------------------------------------------
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  // --- SMS policy ----------------------------------------------------------
  TIMEZONE: z.string().min(1).default('UTC'),
  DEFAULT_DAILY_SMS_LIMIT: z.coerce.number().int().positive().default(100),
  MESSAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  /**
   * SMS PARTS one SIM may send per local day, before the dispatcher refuses to
   * use it.
   *
   * This is not a performance tunable - it is what stops a carrier blacklisting
   * your phone numbers. Indian consumer SIMs are capped around 100/day, and a SIM
   * that sustains bulk-looking traffic gets cut off, frequently for good and
   * frequently several at once when they share an owner. Raise this only if you
   * genuinely know your carrier's limit is higher.
   */
  SIM_DAILY_SMS_LIMIT: z.coerce.number().int().positive().max(1_000).default(100),

  // --- Campaigns (bulk / promotional sending) ------------------------------
  /**
   * Milliseconds the campaign runner waits between one send and the next, when
   * the operator does not specify a pace. Slow on purpose: a personal SIM firing
   * texts at strangers back-to-back is the exact signature a carrier's spam
   * filter blocks for.
   */
  CAMPAIGN_DEFAULT_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * The floor under any pace an operator can pick. This is the safety rail: no
   * campaign, however impatient its operator, may send faster than this, because
   * doing so is what gets a number blacklisted. Raise it, never effectively lower
   * it below a few seconds.
   */
  CAMPAIGN_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
  /** Hard cap on recipients in one campaign - a guardrail against a paste gone wrong. */
  CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().int().positive().max(100_000).default(5_000),
  /**
   * The dialling code prefixed to bare local numbers a campaign pastes in. India
   * by default, since that is where this gateway runs. The operator can override
   * it per campaign; a number already in +CC form is never touched.
   */
  CAMPAIGN_DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^\+[1-9]\d{0,3}$/, 'must be a dialling code like "+91"')
    .default('+91'),
  /**
   * Default sending window, in whole hours of the server's local day (see
   * TIMEZONE). Campaigns only dispatch when the local hour is within
   * [start, end) - business hours by default (09:00-18:00), so a promo blast never
   * goes out at 3am. Each campaign can override these; set start 0 / end 24 to send
   * around the clock.
   */
  CAMPAIGN_WINDOW_START_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  CAMPAIGN_WINDOW_END_HOUR: z.coerce.number().int().min(1).max(24).default(18),

  // --- Gateway -------------------------------------------------------------
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  GATEWAY_OFFLINE_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  // --- OTP -----------------------------------------------------------------
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // We cannot use the Winston logger here: it is itself configured from env.
    console.error(`\n[config] Invalid environment configuration:\n${problems}\n`);
    throw new Error('Invalid environment configuration. See the errors above.');
  }

  // A timezone typo (e.g. "Asia/Calcutta2") must not silently degrade the daily
  // quota reset. Validate it against the ICU database while we can still abort.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: result.data.TIMEZONE });
  } catch {
    throw new Error(`Invalid environment configuration: TIMEZONE "${result.data.TIMEZONE}" is not a known IANA timezone.`);
  }

  // Refuse to boot production with the example secrets still in place.
  if (result.data.NODE_ENV === 'production') {
    const weak = [
      ['JWT_ACCESS_SECRET', result.data.JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', result.data.JWT_REFRESH_SECRET],
    ].filter(([, value]) => value!.startsWith('change_me'));

    if (weak.length > 0) {
      throw new Error(
        `Refusing to start in production with default secrets: ${weak.map(([name]) => name).join(', ')}. ` +
          'Generate real ones with: openssl rand -hex 32',
      );
    }
  }

  return Object.freeze(result.data);
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
