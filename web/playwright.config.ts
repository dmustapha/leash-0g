// File: web/playwright.config.ts
// E2E against a MOCKED backend (route interception in the specs). The app runs in E2E mode:
// a local throwaway signer stands in for Privy so the KEK/crypto path executes for real.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // CI runners are cold + slow — one flake (SSE timing) observed; local stays strict
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // A PRODUCTION build, deliberately — not `next dev`. In dev, Next compiles a route's client
    // bundle on FIRST request, and under parallel workers that compile outran the assertion budget:
    // measured 2026-10-18 (AQ-A0-Q2VIS), `app/layout.js` took 8.1s to serve and the `/agents/[id]`
    // document returned 200 server-rendered in 126ms while its client never hydrated, so the page
    // sat on `Loading status…` and the spec failed on an element that was late, not missing. The
    // same spec passed 12/12 with `--workers=1`. Raising the timeouts only moved the failure to the
    // next-slowest spec, which is budget-chasing; a prebuilt bundle removes the whole class.
    // NOTE: the `env` below must apply to `build`, not just `start` — `NEXT_PUBLIC_*` values are
    // inlined at BUILD time, so starting a prod server with them set is not sufficient.
    // Rationale: 0g-fleet/docs/issues/E2E-DEV-SERVER-COMPILE-BUDGET.md
    command: 'pnpm build && pnpm start --port 3100',
    url: 'http://localhost:3100',
    // Never reuse a stray `next dev` on 3100 — it would silently reintroduce on-demand compilation.
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      NEXT_PUBLIC_E2E_MODE: '1',
      NEXT_PUBLIC_API_URL: 'http://localhost:3100/mock-api',
    },
  },
});
