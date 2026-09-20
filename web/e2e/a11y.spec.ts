// File: web/e2e/a11y.spec.ts
// axe accessibility checks on all three pages: no serious/critical violations.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { freshState, installMockApi } from './mocks';

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test('create page has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/create');
  await expect(page.getByLabel('Agent name')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('cockpit has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/agents/agent-1');
  await expect(page.getByTestId('status-pill')).toBeVisible();
  await expect(page.getByTestId('approval-card')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('audit page has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/agents/agent-1/audit');
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
  await expectNoSeriousViolations(page);
});
