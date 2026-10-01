import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test-live/**'],
    // Heavy integration files build a fresh Neon schema in beforeAll; under a
    // full-suite run (serial, fileParallelism:false) sustained load can push
    // that setup past 60s and flake (Stage-E DEPLOY-FIX, 2026-10-01). 120s gives
    // schema setup headroom without masking a genuine hang.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
