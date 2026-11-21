import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { MongoClient } from 'mongodb';

/**
 * Database seed.
 *
 * Creates the first ADMIN so a fresh deployment has someone who can log in, plus
 * the default settings the dashboard expects to exist. It also creates the
 * unique index on `users.email`, so a database seeded by this script is already
 * correct even if the server has never booted against it.
 *
 * Two properties make it safe to run repeatedly:
 *
 *  - It is **idempotent.** `npm run db:seed` twice is a no-op the second time,
 *    not a crash and not a second admin.
 *  - It **refuses to invent a password.** If SEED_ADMIN_PASSWORD is not set it
 *    generates a random one and prints it exactly once. A seed script that
 *    hard-codes `admin/admin` is how production systems get owned - and everyone
 *    always means to change it later.
 *
 * It talks to the driver directly rather than importing the repository layer,
 * because it is an operational tool: it must keep working on a day when the
 * application itself does not compile.
 */

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?directConnection=true';
const MONGODB_DB = process.env.MONGODB_DB ?? 'smsgw';

/** Declared locally, and only as far as the seed needs: this script must not depend on src/. */
interface SeedUserDoc {
  _id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'ADMIN' | 'USER' | 'VIEWER';
  isActive: boolean;
  dailySmsLimit: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SeedSettingDoc {
  /** The setting key *is* the primary key - there is no second identifier worth carrying. */
  _id: string;
  value: unknown;
  description: string;
  updatedAt: Date;
}

function generatePassword(): string {
  // Readable, unambiguous, and long enough that nobody is brute-forcing it.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 20 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

async function main(): Promise<void> {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    const users = db.collection<SeedUserDoc>('users');
    const settings = db.collection<SeedSettingDoc>('settings');

    // The unique index must exist *before* we insert, or a concurrent second run
    // would create a duplicate admin instead of being a clean no-op.
    await users.createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' });

    const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@sms-gateway.local').trim().toLowerCase();

    const providedPassword = process.env.SEED_ADMIN_PASSWORD;
    const password = providedPassword ?? generatePassword();
    const generated = !providedPassword;

    const existing = await users.findOne({ email });

    if (existing) {
      console.log(`✓ Admin already exists: ${email} (password unchanged)`);
    } else {
      const now = new Date();

      await users.insertOne({
        _id: randomUUID(),
        email,
        name: 'Administrator',
        passwordHash: await bcrypt.hash(password, 12),
        role: 'ADMIN',
        isActive: true,
        dailySmsLimit: Number(process.env.DEFAULT_DAILY_SMS_LIMIT ?? 100),
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });

      console.log(`✓ Created admin: ${email}`);

      if (generated) {
        console.log('');
        console.log('  ┌─────────────────────────────────────────────────────────┐');
        console.log('  │  GENERATED ADMIN PASSWORD - shown once, not recoverable  │');
        console.log('  └─────────────────────────────────────────────────────────┘');
        console.log(`     ${password}`);
        console.log('');
        console.log('  Store it now, then change it at POST /api/auth/change-password.');
        console.log('');
      }
    }

    // Runtime-editable configuration. Env vars are for things that differ per
    // *environment*; these are for things an operator changes without a redeploy.
    const defaults: Array<Pick<SeedSettingDoc, '_id' | 'value' | 'description'>> = [
      {
        _id: 'default_daily_sms_limit',
        value: Number(process.env.DEFAULT_DAILY_SMS_LIMIT ?? 100),
        description: 'Daily SMS quota applied to newly created users.',
      },
      {
        _id: 'message_max_attempts',
        value: 3,
        description: 'How many times a failed message is retried before it is marked FAILED.',
      },
      {
        _id: 'gateway_offline_timeout_ms',
        value: 90_000,
        description: 'Silence after which a connected device is declared offline and its work re-dispatched.',
      },
      {
        _id: 'allow_public_registration',
        value: true,
        description: 'When false, only an ADMIN can create new accounts.',
      },
    ];

    for (const setting of defaults) {
      await settings.updateOne(
        { _id: setting._id },
        {
          // $setOnInsert on `value`, not $set: an operator who has tuned a
          // setting in the dashboard must not have it silently reset by the next
          // deploy. The description is safe to refresh - it is documentation.
          $setOnInsert: { value: setting.value },
          $set: { description: setting.description, updatedAt: new Date() },
        },
        { upsert: true },
      );
    }

    console.log(`✓ Seeded ${defaults.length} settings`);
    console.log(`✓ Database: ${MONGODB_DB}`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
