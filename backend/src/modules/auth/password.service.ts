import bcrypt from 'bcryptjs';

import { env } from '../../config/env.js';

/**
 * Password hashing.
 *
 * bcrypt with a configurable cost factor (default 12). We use `bcryptjs` rather
 * than the native `bcrypt` binding deliberately: it needs no C++ toolchain, so
 * `npm install` works identically on a Windows laptop, an Alpine container and
 * a CI runner. The cost of that portability is a slower hash, which at cost 12
 * is ~250ms - and a *slow* password hash is the entire point.
 *
 * `verifyDummy()` is the subtle one. Read its comment before touching login.
 */

/**
 * A pre-computed hash of a value nobody knows.
 *
 * When login is attempted against an email that does not exist, we must still
 * burn the same ~250ms a real bcrypt comparison costs. Otherwise "unknown email"
 * returns in 2ms and "wrong password" returns in 250ms, and an attacker can
 * enumerate your entire user table with a stopwatch - no matter how carefully
 * you word the error message.
 */
const DUMMY_HASH = bcrypt.hashSync('a-password-that-will-never-be-used-for-anything', 12);

export const passwordService = {
  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, env.BCRYPT_ROUNDS);
  },

  async verify(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  },

  /**
   * Call this on the "user not found" branch of login, then return the same
   * generic error. Constant-ish time, no enumeration oracle.
   */
  async verifyDummy(plaintext: string): Promise<false> {
    await bcrypt.compare(plaintext, DUMMY_HASH);
    return false;
  },
};
