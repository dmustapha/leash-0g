// File: web/e2e/phase3.spec.ts
// Phase-3 daily loop against the mocked backend: the boundary-decision flow (alert card →
// approve → outcome), limit_hit adjust + dismiss, mark-all-read, digest mark-caught-up, and
// the alert-settings surfaces (prefs, telegram link, key setup).
import { expect, test } from '@playwright/test';
import { freshState, installMockApi, mockAlert, type MockState } from './mocks';

function boundaryState(): MockState {
  const state = freshState();
  state.approvalPending = false; // the inbox card is the decision surface under test
  state.alerts = [
    mockAlert('al-appr', {
      class: 'decision',
      kind: 'approval_required',
      summary: 'Treasury helper wants to send 0.02 0G — approve?',
      refs: { approvalId: 'apr-1' },
    }),
  ];
  return state;
}

test('boundary event: inbox card visible → approve → outcome visible', async ({ page }) => {
  const state = boundaryState();
  await installMockApi(page, state);
  await page.goto('/inbox');

  const card = page.getByTestId('alert-al-appr');
  await expect(card).toBeVisible();
  await expect(card.getByText('Treasury helper wants to send 0.02 0G — approve?')).toBeVisible();

  await card.getByTestId('alert-approve-btn').click();

  // Same rails as the cockpit: POST /api/approvals/:id recorded by the mock…
  await expect.poll(() => state.approvalDecided?.decision).toBe('approve');
  // …and the resolved outcome renders in place.
  await expect(card.getByTestId('alert-resolution')).toHaveText(/Approved/);
  await expect(card.getByTestId('alert-approve-btn')).toHaveCount(0);
});

test('limit_hit card: plain copy, adjust deep-link, dismiss', async ({ page }) => {
  const state = freshState();
  state.approvalPending = false;
  state.alerts = [
    mockAlert('al-limit', {
      class: 'decision',
      kind: 'limit_hit',
      summary: 'Treasury helper hit its spending window cap.',
      refs: { errorName: 'OverWindowCap', boundaryClearsAtUnix: Math.floor(Date.now() / 1000) + 3600 },
    }),
    mockAlert('al-info', { kind: 'runtime_error', count: 3, summary: 'The agent kept erroring.' }),
  ];
  await installMockApi(page, state);
  await page.goto('/inbox');

  const card = page.getByTestId('alert-al-limit');
  await expect(card.getByTestId('decoded-plain')).toContainText('spending window cap');
  await expect(card.getByTestId('limit-countdown')).toContainText('Resets in');
  await expect(card.getByTestId('alert-adjust-link')).toHaveAttribute('href', '/agents/agent-1#policy-panel');

  // Coalesced info alert shows ×N.
  await expect(page.getByTestId('alert-al-info').getByTestId('alert-count')).toHaveText('×3');

  await card.getByTestId('alert-dismiss-btn').click();
  await expect(card.getByTestId('alert-resolution')).toHaveText(/Dismissed/);
});

test('mark all read clears the unread pill', async ({ page }) => {
  const state = freshState();
  state.approvalPending = false;
  state.alerts = [mockAlert('al-1'), mockAlert('al-2', { kind: 'throttle' })];
  await installMockApi(page, state);
  await page.goto('/inbox');

  await expect(page.getByTestId('inbox-unread-pill')).toHaveText('2 unread');
  await page.getByTestId('mark-all-read-btn').click();
  await expect(page.getByTestId('inbox-caught-up-pill')).toBeVisible();
});

test('digest: balance change rendered, mark caught up → empty state', async ({ page }) => {
  const state = freshState();
  state.approvalPending = false;
  await installMockApi(page, state);
  await page.goto('/digest');

  const agentCard = page.getByTestId('digest-agent-agent-1');
  await expect(agentCard.getByText('Balance change')).toBeVisible();
  await expect(agentCard.getByTestId('balance-change')).toHaveText('-0.02 0G');

  await page.getByTestId('mark-caught-up-btn').click();
  await expect(page.getByTestId('digest-empty')).toHaveText('Nothing new since you last looked.');
});

test('alert settings: key setup gate, prefs PATCH, telegram deep-link', async ({ page }) => {
  const state = freshState();
  state.approvalPending = false;
  await installMockApi(page, state);
  await page.goto('/settings/alerts');

  // Key not set → the guided setup leads the page.
  await expect(page.getByTestId('stream-key-setup')).toBeVisible();

  // In-app locked for decisions; Telegram toggle PATCHes the merged prefs map.
  await expect(page.getByTestId('inapp-approval_required')).toBeDisabled();
  // click (not check): the checkbox is controlled — it only reflects checked AFTER the PATCH
  // round-trip, which check()'s post-click verification races against.
  await page.getByTestId('telegram-revoked').click();
  await expect
    .poll(() =>
      state.settingsPatches.some(
        (p) =>
          typeof p['alertPrefs'] === 'object' &&
          (p['alertPrefs'] as Record<string, { telegram?: boolean }>)['revoked']?.telegram === true,
      ),
    )
    .toBe(true);

  // Telegram link flow → deep link shown as a clickable link.
  await page.getByTestId('telegram-link-btn').click();
  await expect(page.getByTestId('telegram-deep-link').locator('a')).toHaveAttribute(
    'href',
    'https://t.me/leash_test_bot?start=e2e-token',
  );

  // Owner audit surface with the server-verified pill.
  await expect(page.getByTestId('owner-chain-verified')).toBeVisible();
});
