import type { ApiKeyScope, Role } from '../domain/user.js';

/**
 * Express type augmentation.
 *
 * Express 5 makes `req.query` a lazily-computed getter, so middleware can no
 * longer overwrite it with a parsed value. We therefore park everything Zod has
 * validated on `req.validated` - a single, explicitly-typed home for
 * "input we have proven is safe", which handlers read instead of touching the
 * raw request.
 */

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Set by the requestId middleware. */
      id: string;

      /** Output of the `validate()` middleware. Only the parts you declared are present. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };

      /**
       * The authenticated principal - set by `authenticate`, regardless of whether
       * they presented a JWT or an API key. Handlers never care which.
       */
      user?: {
        id: string;
        email: string;
        role: Role;
      };

      /** Present only when the caller authenticated with an API key. Drives scope checks. */
      apiKey?: {
        id: string;
        scopes: ApiKeyScope[];
      };

      /** The authenticated Android gateway device. Populated in Phase 5. */
      gateway?: {
        id: string;
        deviceId: string;
        userId: string;
      };
    }
  }
}

export {};
