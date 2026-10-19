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
  // /create opens on the intent FUNNEL (app/create/page.tsx:181); the wizard sits behind
  // "Set it up manually". The funnel's own a11y is covered by funnel.spec.ts — this test
  // audits the wizard, so skip straight to it.
  await page.getByTestId('funnel-manual').click();
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

test('cockpit direction surfaces (DirectBox read-back + StatusChat answer) have no serious/critical a11y violations', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/agents/agent-1');
  await expect(page.getByTestId('direct-box')).toBeVisible();
  // Open the read-back and surface a status answer, then audit the fuller DOM.
  await page.getByTestId('direct-intent').fill('keep the balance at 2 0G');
  await page.getByTestId('direct-submit').click();
  await expect(page.getByTestId('read-back')).toBeVisible();
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
  // The hero rises in on a staggered reveal, so an h1 that is merely *visible* is still
  // mid-fade. axe composites a partly-transparent element against what shows through it,
  // so auditing here once measured the primary CTA at `bgColor: #596b27` — lime blended
  // down by the near-black canvas — and reported 3.35:1 on a control that settles at
  // ~16:1. That made this test fail roughly 2 runs in 5: a long-standing flake, not a
  // regression. Waiting for the hero's reveals to reach opacity 1 audits the page the
  // owner actually reads, which is the only state this test means to assert.
  //
  // STAGE G-2.0 re-pointed this from `.reveal-2` (retired with landing.css) onto the
  // imported build's own mechanism. We wait on the h1's `.reveal-swipe` lines, NOT the
  // `.reveal-up` blocks: reveal-swipe runs a load-time mask animation (opacity 0→1,
  // `forwards`) and the headline is always above the fold, so it reliably settles to 1.
  // reveal-up, by contrast, only reveals when its IntersectionObserver fires — and at
  // Playwright's 1280×720 viewport the hero's CTA sits below the ~800px fold, so it never
  // intersects and stays at opacity 0 (which axe skips as invisible — not a violation; the
  // flake this guard exists for was a *mid-fade* element, and settling the headline past
  // its animation window is what proves nothing in the hero is caught mid-transition).
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('#hero .reveal-swipe')];
    return els.length > 0 && els.every((el) => getComputedStyle(el).opacity === '1');
  });
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

// — Stage D: capability granting surfaces (CapabilityGrant + JIT decision card + envelope) —
test('cockpit capability surfaces have no serious/critical a11y violations, keyboard-reachable', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/agents/agent-1');
  // All three Stage-D surfaces render (grant picker, pending JIT card, envelope).
  await expect(page.getByTestId('capability-grant')).toBeVisible();
  await expect(page.getByTestId('capability-decision-card')).toBeVisible();
  await expect(page.getByTestId('capability-envelope')).toBeVisible();

  // The quarantined decoded intent is PLAIN TEXT, never parsed as HTML (no injected <script>).
  await expect(page.getByTestId('jit-intent')).toContainText('<script>ignore</script>');
  expect(await page.locator('script:has-text("ignore")').count()).toBe(0);

  await expectNoSeriousViolations(page);

  // Keyboard-only: a preset button is focusable + activatable via the keyboard.
  const preset = page.getByTestId('preset-defi_trader');
  await preset.focus();
  await expect(preset).toBeFocused();
  await preset.press('Enter');
  await expect(page.getByTestId('preset-flow')).toBeVisible();
});

test('JIT deep-link (/app?agent=&jit=) routes to the cockpit and focuses the JIT card', async ({ page }) => {
  await installMockApi(page, freshState());
  await page.goto('/app?agent=agent-1&jit=req-1');
  // The /app deep-link redirect lands on the cockpit carrying ?jit.
  await expect(page).toHaveURL(/\/agents\/agent-1\?jit=req-1/);
  await expect(page.getByTestId('capability-decision-card')).toBeVisible();
});
