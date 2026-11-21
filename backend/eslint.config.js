import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules that encode the conventions this codebase relies on:
 *  - no floating promises (a dropped `await` on a queue publish loses an SMS)
 *  - no `any` escaping into shared code
 *  - explicit module boundaries stay honest
 */
export default tseslint.config(
  {
    // public/ is the browser-side admin panel - static assets served as-is, not
    // part of the Node/TS program, so the type-aware Node linting here does not
    // apply to it (it would flag `window`, `localStorage`, `fetch` as undefined).
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // Express middleware signature is (req, res, next) => void; an async
        // handler technically returns a Promise. Express 5 handles it correctly.
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // This config file and any other plain JS are not part of the TS program;
    // type-aware rules cannot run on them.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The seed script is a CLI tool. Printing a generated admin password to the
    // operator's terminal is its entire job, and Winston is the wrong channel
    // for that - it would end up shipped to a log aggregator.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
