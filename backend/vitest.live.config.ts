import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-live/**/*.live.test.ts'],
    hookTimeout: 300_000,
    testTimeout: 300_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
