import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['test-live/**'],
    // Integration files build a fresh per-file schema in beforeAll; 120s gives
    // schema setup headroom without masking a genuine hang.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
    // TA-FLAKE-1 (2026-10-10, see tasks/e2e-tearapart-findings.md): the suite was
    // NON-DETERMINISTIC (~7–17% of full runs flaked, rotating victim). Root cause
    // is a DEV-ONLY test-mock bug — nock@14 → @mswjs/interceptors@0.41.9 globally
    // patches http.ClientRequest and, under concurrent in-process HTTP, its
    // MockHttpSocket mis-frames a response (loud: Parse Error/ECONNRESET/garbled
    // header; quiet: wrong status). It fronts BOTH the app's mocked fetch calls
    // and supertest's localhost passthrough, so any HTTP spec can be a victim.
    // ZERO production surface (nock is a devDependency; prod uses real HTTP).
    // Fixes that were tried + DISPROVEN: fileParallelism (3/25 still failed, not
    // single-worker load) and nock 15 (newer interceptors, but hangs the dynamic
    // .reply() callback specs). The nock-15 migration is tracked tech-debt.
    // Interim: retry ONLY the integration suite (the one that drives supertest +
    // nock) — the project's existing "green on re-run" posture — so the rare
    // mis-framed request is absorbed. unit AND redteam specs are pure (no
    // supertest/nock/HTTP), so they are NOT retried and real logic bugs fail
    // hard. Product correctness is independently proven: every victim is green
    // in isolation with no product-code error.
    // NOTE: with `projects`, test discovery is per-project include globs — any
    // NEW test/ subdirectory must be added to a project below or it won't run.
    projects: [
      {
        extends: true,
        // pure specs (no HTTP mock in the path) → hard-fail, no retry.
        test: { name: 'unit', include: ['test/unit/**/*.test.ts', 'test/redteam/**/*.test.ts'] },
      },
      {
        extends: true,
        // supertest + nock HTTP specs → susceptible to the TA-FLAKE-1 mock race.
        test: { name: 'integration', include: ['test/integration/**/*.test.ts'], retry: 2 },
      },
    ],
  },
});
