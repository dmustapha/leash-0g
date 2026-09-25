// File: web/e2e/funnel.spec.ts
// Phase-5 (D-B7): the 2-screen create funnel happy path against the MOCKED backend.
// intent → tiered read-back → confirm → wizard review → create. Plus the template path.
import { expect, test } from '@playwright/test';
import { freshState, installMockApi } from './mocks';

test.describe('create funnel (intent → read-back → confirm)', () => {
  test('2-screen happy path via elevation', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);

    await page.goto('/create');

    // Screen 1: intent.
    await expect(page.getByTestId('funnel-entry')).toBeVisible();
    await page.getByTestId('funnel-intent').fill('give me calibrated odds on market questions');
    await page.getByTestId('funnel-elevate').click();

    // Screen 2: tiered read-back. Both tiers + the money-power line.
    await expect(page.getByTestId('read-back')).toBeVisible();
    await expect(page.getByTestId('tier-what-it-does')).toBeVisible();
    await expect(page.getByTestId('tier-the-leash')).toBeVisible();
    await expect(page.getByTestId('read-back-money-power')).toContainText(/can never move money/i);
    // A spend-incapable provider needs no address — confirm lands on the wizard review.
    await page.getByTestId('read-back-confirm').click();

    // Wizard, jumped straight to review, then create.
    await expect(page.getByTestId('review-summary')).toBeVisible();
    await expect(page.getByTestId('review-summary')).toContainText('market forecaster');
    await page.getByTestId('create-agent').click();

    await expect(page.getByTestId('gateway-token')).toBeVisible();
    // The capability label was threaded through create.
    expect(state.createBody?.capabilityLabel).toBe('market forecaster');
    expect(state.createBody?.goal).toEqual({ type: 'provider', serviceSpec: 'calibrated probability estimates for market questions' });
  });

  test('template path skips elevation', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);

    await page.goto('/create');
    await page.getByTestId('template-research-summarizer').click();
    await expect(page.getByTestId('read-back')).toBeVisible();
    await page.getByTestId('read-back-confirm').click();
    await expect(page.getByTestId('review-summary')).toBeVisible();
    await page.getByTestId('create-agent').click();
    await expect(page.getByTestId('gateway-token')).toBeVisible();
    expect(state.createBody?.capabilityLabel).toBe('research summarizer');
  });

  test('manual escape goes straight to the role-first wizard', async ({ page }) => {
    const state = freshState();
    await installMockApi(page, state);
    await page.goto('/create');
    await page.getByTestId('funnel-manual').click();
    await expect(page.getByLabel('Agent name')).toBeVisible();
    await expect(page.getByTestId('read-back')).toHaveCount(0);
  });
});
