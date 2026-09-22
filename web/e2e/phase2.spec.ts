// File: web/e2e/phase2.spec.ts
// Phase-2 E2E vs the MOCKED backend (spec §8 Frontend row): fleet list →
// create-second-agent (role chooser) → create link → delegation timeline (fetched +
// live SSE merge) → revoke pair happy path, plus the C-2 partial-failure steer.
import { expect, test } from '@playwright/test';
import { freshState, installMockApi, mockAgent, type MockState } from './mocks';

const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function pairState(): MockState {
  const state = freshState();
  state.approvalPending = false;
  state.agents.push(mockAgent('agent-2', 'Executor'));
  state.links.push({
    id: 'link-1',
    ownerAddr: '0x3333333333333333333333333333333333333333',
    fromAgentId: 'agent-1',
    toAgentId: 'agent-2',
    mode: 'auto',
    status: 'active',
    createdAt: new Date().toISOString(),
    delegationCount: 0,
  });
  return state;
}

test('fleet list → create second agent (executor) → link → pair timeline → revoke pair', async ({ page }) => {
  const state = freshState();
  state.approvalPending = false;
  await installMockApi(page, state);

  // — Fleet list (now at /app; / is the landing) shows the Phase-1 agent fetched from the backend
  await page.goto('/app');
  await expect(page.getByTestId('fleet-list')).toBeVisible();
  await expect(page.getByTestId('fleet-row-agent-1')).toContainText('Treasury helper');

  // — Create the SECOND agent through the wizard, choosing the executor role
  await page.getByRole('link', { name: 'Create agent' }).first().click();
  await page.getByLabel('Agent name').fill('Executor');
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('role-executor').check();
  // executor: goal amount fields disappear
  await expect(page.getByTestId('executor-goal-note')).toBeVisible();
  await expect(page.getByLabel('Who to keep topped up')).toHaveCount(0);
  await page.getByTestId('wizard-next').click(); // → per-payment cap
  await page.getByTestId('wizard-next').click(); // → budget
  await page.getByTestId('wizard-next').click(); // → allowlist
  await page.getByLabel('Allowed recipient').fill(PAYEE); // not seeded (no beneficiary)
  await page.getByTestId('wizard-next').click(); // → expiry
  await page.getByTestId('wizard-next').click(); // → review
  await expect(page.getByTestId('review-summary')).toContainText('acts on requests');
  await page.getByTestId('create-agent').click();
  await expect(page.getByTestId('gateway-token')).toBeVisible();
  expect(state.createBody?.goal).toEqual({ type: 'executor' });
  expect(state.createBody?.allowlist).toEqual([PAYEE]);

  // — Fleet now lists both; create the link A → B
  await page.goto('/links');
  await page.getByLabel('From (the agent that asks)').selectOption('agent-1');
  await page.getByLabel('To (the agent that acts)').selectOption('agent-2');
  await page.getByRole('radio', { name: /Supervised/ }).check();
  await page.getByTestId('create-link-btn').click();
  await expect(page.getByTestId('link-row-link-1')).toContainText('Treasury helper → Executor');
  await expect(page.getByTestId('link-row-link-1')).toContainText('supervised');

  // — Pair view: fetched delegation renders; a live SSE delegation event merges in
  state.delegations.push({
    id: 'del-1',
    linkId: 'link-1',
    fromAgentId: 'agent-1',
    toAgentId: 'agent-2',
    kind: 'transfer.request',
    payload: { amountWei: '1' },
    status: 'completed',
    result: { txHash: '0x' + 'd'.repeat(64) },
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  state.delegationEvents['agent-2'] = [
    {
      type: 'delegation',
      delegationId: 'del-2',
      linkId: 'link-1',
      status: 'accepted',
      kind: 'transfer.request',
      counterpartyAgentId: 'agent-1',
      direction: 'inbound',
      ts: new Date().toISOString(),
    },
  ];
  await page.getByRole('link', { name: 'Treasury helper → Executor' }).click();
  // First hit compiles the pair route on the dev server — under parallel
  // workers that can exceed the 5s default (infra latency, not app behavior).
  await expect(page.getByRole('heading', { name: 'Treasury helper → Executor' })).toBeVisible({ timeout: 20_000 });
  const timeline = page.getByTestId('delegation-timeline');
  await expect(timeline.getByTestId('delegation-del-1')).toContainText('done');
  await expect(page.getByTestId('delegation-tx-del-1')).toHaveAttribute('href', /chainscan/);
  // live event (SSE) appears without a refetch
  await expect(timeline.getByTestId('delegation-del-2')).toContainText('being worked on');

  // — Revoke the pair in one action; per-agent results rendered honestly
  await page.getByTestId('revoke-pair-btn').click();
  await page.getByTestId('confirm-revoke-pair-btn').click();
  await expect(page.getByTestId('revoke-result-agent-1')).toContainText('revoked');
  await expect(page.getByTestId('revoke-result-agent-2')).toContainText('revoked');
  expect(state.revokeBatchBody).toEqual({ agentIds: ['agent-1', 'agent-2'] });
});

test('revoke pair partial failure steers to the owner-wallet fallback (C-2)', async ({ page }) => {
  const state = pairState();
  state.failRevokeIds = ['agent-2'];
  await installMockApi(page, state);

  await page.goto('/links/link-1');
  await page.getByTestId('revoke-pair-btn').click();
  await page.getByTestId('confirm-revoke-pair-btn').click();
  await expect(page.getByTestId('revoke-result-agent-1')).toContainText('revoked');
  await expect(page.getByTestId('revoke-result-agent-2')).toContainText('FAILED');
  const fallback = page.getByTestId('revoke-fallback-agent-2');
  await expect(fallback).toContainText('works even if LEASH is down');
  await expect(fallback.getByTestId('wallet-revoke-agent-2')).toBeVisible();
});

test('single cockpit revoke 502 shows the guardian-failed steer (C-2)', async ({ page }) => {
  const state = freshState();
  state.approvalPending = false;
  state.singleRevokeFails = true;
  await installMockApi(page, state);

  await page.goto('/agents/agent-1');
  await page.getByTestId('revoke-btn').click();
  await page.getByTestId('confirm-revoke-btn').click();
  const steer = page.getByTestId('guardian-revoke-failed');
  await expect(steer).toContainText('could not revoke via its guardian');
  await expect(steer.getByTestId('steer-revoke-onchain-btn')).toBeVisible();
  // agent NOT marked revoked
  await expect(page.getByTestId('status-pill')).toHaveText('running');
});

test('link management: pause, mode toggle, remove', async ({ page }) => {
  const state = pairState();
  await installMockApi(page, state);

  await page.goto('/links');
  await page.getByTestId('pause-link-link-1').click();
  await expect(page.getByTestId('link-row-link-1')).toContainText('paused');
  await page.getByTestId('resume-link-link-1').click();
  await page.getByTestId('toggle-mode-link-1').click();
  await expect(page.getByTestId('link-row-link-1')).toContainText('supervised');
  await page.getByTestId('remove-link-link-1').click();
  await expect(page.getByTestId('link-row-link-1')).toContainText('removed');
  expect(state.linkActions.map((a) => a.body)).toEqual([
    { action: 'pause' },
    { action: 'resume' },
    { mode: 'supervised' },
    { action: 'remove' },
  ]);
});

test('cockpit shows the server-verified pill from the traces response', async ({ page }) => {
  const state = freshState();
  state.approvalPending = false;
  await installMockApi(page, state);

  await page.goto('/agents/agent-1');
  await expect(page.getByTestId('server-verified-pill')).toBeVisible();
});
