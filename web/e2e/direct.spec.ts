// File: web/e2e/direct.spec.ts
// Phase-5.5 (spec §9): the cockpit conversational-direction surfaces against the MOCKED backend.
// DirectBox: type → read-back → confirm, asserting the confirm body (edited draft + out-of-band
// recipient). StatusChat: ask → plain-text answer.
import { expect, test } from '@playwright/test';
import { freshState, installMockApi, MOCK_PAYEE } from './mocks';

test.describe('cockpit conversational direction', () => {
  test('DirectBox: type → read-back → confirm sends the edited draft + recipient', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);

    await page.goto('/agents/agent-1');
    await expect(page.getByTestId('status-pill')).toBeVisible();

    // Command box → read it back.
    await page.getByTestId('direct-intent').fill('keep the balance at 2 0G');
    await page.getByTestId('direct-submit').click();

    await expect(page.getByTestId('read-back')).toBeVisible();
    await expect(page.getByTestId('read-back-money-power')).toContainText(/can move money/i);
    await expect(page.getByTestId('read-back-understanding')).toContainText('2 0G');

    // A can-move-money role must be given a recipient before confirm.
    await page.getByTestId('rb-recipient').fill(MOCK_PAYEE);
    await page.getByTestId('read-back-confirm').click();

    // The confirm went out with the edited draft and the recipient out-of-band.
    await expect.poll(() => state.confirmDirectionBody).toBeTruthy();
    const body = state.confirmDirectionBody!;
    expect(body.recipient).toBe(MOCK_PAYEE);
    const edited = body.edited as { goalPatch: Record<string, unknown> };
    expect(edited.goalPatch.targetBalanceWei).toBe('2000000000000000000');
    // Recipient never smuggled into the quarantined draft.
    expect(JSON.stringify(edited)).not.toContain(MOCK_PAYEE);
  });

  test('StatusChat: ask returns a plain-text, unverified answer', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);

    await page.goto('/agents/agent-1');
    await expect(page.getByTestId('status-chat')).toBeVisible();

    await page.getByTestId('status-chat-q').fill('what have you done so far?');
    await page.getByTestId('status-chat-ask').click();

    await expect(page.getByTestId('status-chat-answer')).toContainText('topped up the beneficiary');
    await expect(page.getByTestId('status-chat-unverified')).toContainText(/unverified/i);
  });

  test('keyboard-only: DirectBox and StatusChat are operable via the keyboard', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);
    await page.goto('/agents/agent-1');
    await expect(page.getByTestId('direct-box')).toBeVisible();

    // Focus the intent box directly, type, then tab to the submit button and activate it.
    await page.getByTestId('direct-intent').focus();
    await page.keyboard.type('keep the balance at 2 0G');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('direct-submit')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('read-back')).toBeVisible();

    // Status box is reachable and its answer surfaces via keyboard activation.
    await page.getByTestId('read-back-back').click();
    await page.getByTestId('status-chat-q').focus();
    await page.keyboard.type('status?');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('status-chat-ask')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-chat-answer')).toBeVisible();
  });
});
