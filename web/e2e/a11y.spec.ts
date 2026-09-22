// File: web/e2e/a11y.spec.ts
// axe accessibility checks on every page (Phase 1 + Phase 2): no serious/critical violations.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { freshState, installMockApi, mockAgent, mockAlert, type MockState } from './mocks';

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

function pairState(): MockState {
  const state = freshState();
  state.agents.push(mockAgent('agent-2', 'Executor'));
  state.links.push({
    id: 'link-1',
    ownerAddr: '0x3333333333333333333333333333333333333333',
    fromAgentId: 'agent-1',
    toAgentId: 'agent-2',
    mode: 'supervised',
    status: 'active',
    createdAt: new Date().toISOString(),
    delegationCount: 1,
  });
  state.delegations.push({
    id: 'del-1',
    linkId: 'link-1',
    fromAgentId: 'agent-1',
    toAgentId: 'agent-2',
    kind: 'transfer.request',
    payload: {},
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  return state;
}

test('fleet list (/app) has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, pairState());
  await page.goto('/app');
  await expect(page.getByTestId('fleet-list')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('landing (/) has no serious/critical a11y violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('links page has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, pairState());
  await page.goto('/links');
  await expect(page.getByTestId('link-row-link-1')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('pair view has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, pairState());
  await page.goto('/links/link-1');
  await expect(page.getByTestId('delegation-timeline')).toBeVisible();
  await expect(page.getByTestId('delegation-del-1')).toBeVisible();
  await expectNoSeriousViolations(page);
});

// — Phase 3 pages —

test('inbox has no serious/critical a11y violations', async ({ page }) => {
  const state = freshState();
  state.alerts = [
    mockAlert('al-appr', {
      class: 'decision',
      kind: 'approval_required',
      summary: 'Treasury helper wants to send 0.02 0G — approve?',
      refs: { approvalId: 'apr-1' },
    }),
    mockAlert('al-limit', {
      class: 'decision',
      kind: 'limit_hit',
      summary: 'Treasury helper hit its spending window cap.',
      refs: { errorName: 'OverWindowCap', boundaryClearsAtUnix: Math.floor(Date.now() / 1000) + 3600 },
    }),
    mockAlert('al-info', { kind: 'runtime_error', count: 2 }),
  ];
  await installMockApi(page, state);
  await page.goto('/inbox');
  await expect(page.getByTestId('alert-al-appr')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('digest has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/digest');
  await expect(page.getByTestId('digest-agent-agent-1')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('alert settings has no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/settings/alerts');
  await expect(page.getByTestId('stream-key-setup')).toBeVisible();
  await expectNoSeriousViolations(page);
});
