import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/** Workspace packages resolve to their source entry in tests, so nothing needs building first. */
const entry = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/** Browser, accuracy and contract tiers; everything else under `test/` is the fast unit tier (ADR 0017). */
const SLOW = [
  '**/*.browser.test.ts',
  '**/*.accuracy.test.ts',
  '**/*.contract.test.ts',
];

export default defineConfig({
  resolve: {
    alias: {
      '@flowctl/core-testing': fileURLToPath(
        new URL('./packages/core/test/support.ts', import.meta.url),
      ),
      '@flowctl/core': entry('core'),
      '@flowctl/fixture-app': entry('fixture-app'),
    },
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...SLOW],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['packages/*/test/**/*.browser.test.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'accuracy',
          include: ['packages/*/test/**/*.accuracy.test.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['packages/*/test/**/*.contract.test.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
        },
      },
    ],
  },
});
