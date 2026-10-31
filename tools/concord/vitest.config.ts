import { defineConfig } from 'vitest/config';

// Three-tier quarantine (contract rule 24):
//   *.test.ts  — offline unit tests, the default gate (no network).
//   *.live.ts  — live-network tests (real api.leash.ink probe), EXCLUDED here.
// The default `vitest run` must NOT run the live tier.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.live.ts', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
