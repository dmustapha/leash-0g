import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test-live/**'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
