import { defineConfig } from 'vitest/config';

/**
 * Test runner configuration.
 *
 * `test.env` supplies a complete, valid environment. This is deliberate: the app
 * refuses to boot on invalid config (see src/config/env.ts), so the test suite
 * proves the same code path a real deployment takes - no test-only bypass of
 * validation, and no dependency on a developer's local `.env` file.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    restoreMocks: true,
    env: {
      NODE_ENV: 'test',
      APP_NAME: 'sms-gateway-test',
      PORT: '4999',
      API_PREFIX: '/api',
      LOG_LEVEL: 'error',
      LOG_TO_FILE: 'false',
      CORS_ORIGINS: 'http://localhost:5173',
      // A *separate* database from development. The contract suite wipes every
      // collection between tests, and pointing that at `smsgw` would delete a
      // developer's working data the first time they ran `npm test`.
      MONGODB_URI: 'mongodb://localhost:27017/?directConnection=true',
      MONGODB_DB: 'smsgw_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'test_access_secret_that_is_definitely_long_enough',
      JWT_REFRESH_SECRET: 'test_refresh_secret_that_is_definitely_long_enough',
      TIMEZONE: 'Asia/Kolkata',
      // Real bcrypt, lowest sane cost. Production uses 12 (~250ms per hash);
      // paying that in ~40 test hashes costs half a minute of CI for no extra
      // signal. We are testing the auth logic, not the KDF's work factor.
      BCRYPT_ROUNDS: '10',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types/**', '**/*.d.ts'],
    },
  },
});
