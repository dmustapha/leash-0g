// File: web/e2e/happy-path.spec.ts
// E2E skeleton vs the MOCKED backend: create → watch → approve → revoke, plus the deny path.
// The real-stack E2E (deployed backend, live chain) runs later in the phase.
import { expect, test } from '@playwright/test';
import { freshState, installMockApi, MOCK_PAYEE } from './mocks';

test.describe('create → watch → approve → revoke', () => {
  test('happy path', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);

    // — Create wizard (one decision per step; E2E wallet signs the KEK message for real)
    await page.goto('/create');
    await page.getByLabel('Agent name').fill('Treasury helper');
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('Who to keep topped up').fill(MOCK_PAYEE); // goal step
    await page.getByTestId('wizard-next').click(); // goal amount defaults
    await page.getByTestId('wizard-next').click(); // per-payment default
    await page.getByTestId('wizard-next').click(); // budget defaults
    // allowlist arrives pre-seeded with the beneficiary
    await expect(page.getByLabel('Allowed recipient')).toHaveValue(MOCK_PAYEE);
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click(); // expiry default
    await expect(page.getByTestId('review-summary')).toContainText('Treasury helper');
    await page.getByTestId('create-agent').click();

    // — Gateway token shown once; audit keypair + encrypted blob went to the backend
    await expect(page.getByTestId('gateway-token')).toHaveText('gw_tok_shown_once_abc123');
    expect(state.createBody?.auditPubKey).toBeTruthy();
    expect(String(state.createBody?.encryptedAuditKey)).toContain('"mode":"signature"');
    expect(state.createBody?.name).toBe('Treasury helper');
    expect(state.createBody?.goal).toEqual({
      beneficiary: MOCK_PAYEE,
      targetBalanceWei: '100000000000000000', // 0.1 0G default
      topUpWei: '10000000000000000', // 0.01 0G default
    });

    // — Fund step offered on the done screen; skip it and land in the cockpit
    await expect(page.getByTestId('fund-section')).toBeVisible();
    await page.getByTestId('fund-skip').click();
    await expect(page.getByTestId('status-pill')).toHaveText('running');
    await expect(page.getByTestId('stream-feed')).toContainText('Checking the beneficiary balance');

    // — Approve the boundary decision
    const card = page.getByTestId('approval-card');
    await expect(card).toContainText('Needs your decision');
    await card.getByLabel(/reason/i).fill('yes, top it up');
    await card.getByTestId('approve-btn').click();
    await expect(page.getByTestId('approval-card')).toHaveCount(0);
    expect(state.approvalDecided).toEqual({ decision: 'approve', reason: 'yes, top it up' });

    // — One-move revoke (guardian path) with confirm step
    await page.getByTestId('revoke-btn').click();
    await page.getByTestId('confirm-revoke-btn').click();
    await expect(page.getByTestId('revoked-pill')).toBeVisible();
    await expect(page.getByTestId('status-pill')).toHaveText('revoked');
    expect(state.revokeCalled).toBe(true);
  });

  test('deny path', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);

    await page.goto('/agents/agent-1');
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await card.getByTestId('deny-btn').click();
    await expect(page.getByTestId('approval-card')).toHaveCount(0);
    expect(state.approvalDecided?.decision).toBe('deny');
    // agent keeps running after a deny
    await expect(page.getByTestId('status-pill')).toHaveText('running');
  });

  test('low balance shows the inline fund panel in the cockpit', async ({ page }) => {
    const state = freshState();
    state.approvalPending = false;
    state.accountBalanceWei = '10000000000000000'; // 0.01 0G < 0.05 window cap
    await installMockApi(page, state);

    await page.goto('/agents/agent-1');
    await expect(page.getByTestId('low-balance-warning')).toBeVisible();
    await expect(page.getByTestId('cockpit-fund-section')).toBeVisible();
    // Prefilled with ~2× the window cap
    await expect(page.getByLabel('Amount to send')).toHaveValue('0.1');
  });

  test('pause, resume, and rotate token', async ({ page }) => {
    const state = freshState();
    state.approvalPending = false;
    await installMockApi(page, state);

    await page.goto('/agents/agent-1');
    await page.getByTestId('pause-btn').click();
    await expect(page.getByTestId('status-pill')).toHaveText('paused');
    await page.getByTestId('resume-btn').click();
    await expect(page.getByTestId('status-pill')).toHaveText('running');
    await page.getByTestId('rotate-btn').click();
    await expect(page.getByRole('status').filter({ hasText: 'gw_tok_rotated_xyz789' })).toBeVisible();
  });
});
