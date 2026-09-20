// File: web/playwright.config.ts
// E2E against a MOCKED backend (route interception in the specs). The app runs in E2E mode:
// a local throwaway signer stands in for Privy so the KEK/crypto path executes for real.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_E2E_MODE: '1',
      NEXT_PUBLIC_API_URL: 'http://localhost:3100/mock-api',
    },
  },
});
