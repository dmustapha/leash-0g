// File: web/e2e/q2vis.spec.ts
// AQ-A0-Q2VIS — the owner-facing half of "see why it acted", against the mocked backend.
//
// What this guards, and why it is not covered by happy-path.spec.ts: before D-2 the `reasoning`
// SSE channel carried `completionContent()` — the DECISION JSON — so the cockpit's disclosure
// showed the owner a JSON blob rather than the agent's thinking. That is F-0b-34/35 and it is why
// Q2 was ungradable. The mock's reasoning frame used to be one tidy sentence, which is precisely
// what made the defect invisible here too.
//
// Defect-2 / option (a) then changed what the cockpit SHOWS. The disclosure used to be labelled
// "See full thought process", which promised an explanation over text that a measured 80-call
// probe found to be 92% prompt scaffolding. It is now labelled as a raw payload and preceded by a
// plain surface line, and the owner's actual explanation is the authored `rationale` row. The two
// claims under test are therefore: the label does not over-promise, and the surface line is
// readable WITHOUT opening anything.
//
// This spec is a RENDERING pre-flight, not G-9. G-9 is Dami's eye on the live stack and is not
// delegable to a mock.
// NOTE on selectors: `Disclosure` renders a native <details>/<summary>. Chromium exposes <summary>
// as a disclosure triangle rather than role=button, so these target the <summary> element by text.
//
// NOTE on multiplicity, and why nothing here asserts a positive COUNT over feed rows: the mock
// fulfils the SSE route with a FINITE body, `connectSse` reads the clean body end as a dropped
// connection and reconnects (lib/sse.ts:43-71), and the route replays its canned frames — so every
// frame renders once per reconnect and the row count is a function of how long the spec RUNS
// (measured 1x in fast runs, 3x in a slower screenshot run). The replay is load-bearing: it is the
// mock's only push channel (see the long note in mocks.ts). So: `.first()` + `toBeVisible()`, or a
// count scoped INSIDE one row. `toHaveCount(0)` stays valid — replay multiplies, it cannot
// manufacture an absent element. Root cause: docs/evidence/aq-a0-q2vis/N-FEED-TRIPLICATION-ROOT-CAUSE.md
import { expect, test } from '@playwright/test';
import { freshState, installMockApi } from './mocks';

test.describe('Q2/Q5 owner surface — deliberation + rationale', () => {
  test('the raw-output disclosure shows real deliberation, not the decision JSON', async ({ page }) => {
    const state = freshState();
    state.q2vis = true;
    await installMockApi(page, state);
    await page.goto(`/agents/${state.agentId}`);

    const feed = page.getByTestId('stream-feed');
    await expect(feed).toBeVisible();

    // Defect-2 option (a): while the disclosure is CLOSED the owner reads a plain sentence that
    // says what this text is — and the label calls it a raw payload rather than promising a
    // thought process. The surface line being visible with nothing clicked is the behavioural
    // claim of this change, so it is asserted before the label is.
    const raw = feed.getByTestId('reasoning-raw').first();
    await expect(raw).toBeVisible();
    // VISIBILITY, not text. A collapsed <details> still holds its text in the DOM, so a
    // `toContainText` on the wrapper passes even if the line is nested INSIDE the disclosure —
    // which is the one regression that would silently undo this change. Mutation-proven: moving
    // the line inside the <details> kept a text-based version of this assertion green.
    const surface = raw.getByTestId('reasoning-surface').first();
    await expect(surface).toBeVisible();
    await expect(surface).toContainText("The model's working text while it decided");
    await expect(surface).toContainText('restates its own instructions');
    await expect(surface).toContainText("Agent's own words");
    // The old label over-promised; it must be gone from the page entirely, not merely unused here.
    await expect(feed.getByText(/full thought process/i)).toHaveCount(0);

    // The disclosure is collapsed by default — the raw model voice is never dumped at the owner.
    // NOTE: a collapsed <details> still holds its text in the DOM, so `not.toContainText` cannot
    // express "not shown". Assert on VISIBILITY (and the absence of the `open` attribute) instead.
    const details = raw.locator('details', { hasText: /Show the exact model output \(raw, for review only\)/i }).first();
    const body = details.locator('p');
    await expect(details).toBeVisible();
    await expect(details).not.toHaveAttribute('open', /.*/);
    await expect(body).not.toBeVisible();

    await details.locator('summary').click();
    // Real deliberation: step structure, a self-correction, and plain-language amounts (D-3).
    await expect(body).toBeVisible();
    await expect(body).toContainText('## Step 1');
    await expect(body).toContainText('Actually let me reconsider');
    await expect(body).toContainText('0.012 0G');
    // and it must NOT be the decision JSON, which is what this channel used to carry
    await expect(body).not.toContainText('"action":"send"');
    await expect(body).not.toContainText('amountWei');
  });

  test('the action row shows the plain-language rationale, with no raw wei', async ({ page }) => {
    const state = freshState();
    state.q2vis = true;
    await installMockApi(page, state);
    await page.goto(`/agents/${state.agentId}`);

    const feed = page.getByTestId('stream-feed');
    // D-4 owner layer: the agent's words are shown ATTRIBUTED and QUOTED, never as a verified
    // claim. The authoritative "what happened" is the server-composed summary beside it.
    const voice = feed.getByTestId('trace-agent-voice').first();
    await expect(voice).toContainText("Agent's own words");
    await expect(voice).toContainText('I topped up your beneficiary with 0.01 0G');
    await expect(feed).toContainText('sent 0.01 0G');
    // the amount is in 0G words, never base units, and never mislabelled (G-7 / F-A0-1)
    await expect(feed).not.toContainText('10000000000000000');
    await expect(feed).not.toContainText(/\bETH\b/);
  });

  test('a server-composed stand-down is not quoted back as the agent speaking', async ({ page }) => {
    const state = freshState();
    state.q2vis = true;
    await installMockApi(page, state);
    await page.goto(`/agents/${state.agentId}`);

    const feed = page.getByTestId('stream-feed');
    const row = feed.locator('div', { hasText: /spending window exhausted/ }).last();
    await expect(row).toBeVisible();

    // The server's sentence is the authoritative WHAT. It is NOT the agent's voice: the runtime
    // wrote it, the agent never said it. Attributing it would be a fabricated quote, so the row
    // carries no voice line at all — and the sentence therefore appears exactly once, not twice.
    // The count that carries the claim is the one scoped INSIDE the stand-down row: zero voice
    // lines there. A count over the FEED would be asserting over wall-clock time (see the
    // multiplicity note at the top of this file), so the second half of the claim — that the
    // sentence is not ALSO quoted as speech — is expressed as a page-wide absence instead.
    await expect(row.getByTestId('trace-agent-voice')).toHaveCount(0);
    await expect(feed.getByTestId('trace-agent-voice').filter({ hasText: /spending window exhausted/ })).toHaveCount(0);
    // the action row above still has its genuine rationale — this is a provenance gate, not a mute
    const actionVoice = feed.getByTestId('trace-agent-voice').first();
    await expect(actionVoice).toBeVisible();
    await expect(actionVoice).toContainText('I topped up your beneficiary');
  });

  test('a degenerate cycle degrades to plain language instead of dumping repetition', async ({ page }) => {
    const state = freshState();
    state.q2vis = true;
    await installMockApi(page, state);
    await page.goto(`/agents/${state.agentId}`);

    // C-5: the owner is told what happened in words, and is NOT shown 64 KB of the same sentence.
    const degraded = page.getByTestId('reasoning-degenerate').first();
    await expect(degraded).toBeVisible();
    await expect(degraded).toContainText('got stuck repeating itself');
    await expect(degraded).toContainText('40 times');
    await expect(degraded).toContainText('decision was still read correctly');
    // The signature is available on demand under the SAME payload label the healthy branch uses —
    // one constant, so the two branches cannot drift into over-promising in different ways again.
    await expect(
      degraded.locator('summary', { hasText: /Show the exact model output \(raw, for review only\)/i }),
    ).toBeVisible();
    await expect(page.getByText(/managed to say/i)).toHaveCount(0);
  });
});
