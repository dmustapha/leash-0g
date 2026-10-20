// File: web/tests/stream-feed-reasoning.test.tsx
// AQ-A0-Q2VIS Defect-2, option (a): the reasoning row is a REVIEW surface, not an explanation.
//
// A measured 80-call probe found 92/100 deliberations carry prompt scaffolding — the model
// reciting its own instruction contract — and prompt-side scoping removed only 8 of the 92. So
// the fix is at the surface: one plain line the owner reads WITHOUT clicking, the raw text behind
// a label that calls it a raw payload, and the authored `rationale` left as the only
// full-prominence prose in the feed.
//
// Why this exists alongside e2e/q2vis.spec.ts: the e2e runs against a Next dev server over a
// mocked SSE stream, and both recompile timing and stream ordering make it a noisy instrument for
// a pure render claim (observed: a failure on the wrapper's visibility and a duplicate
// `trace-agent-voice` that another test in the same run contradicted). These assertions are
// deterministic and mutation-checkable in seconds.
//
// The load-bearing assertion is VISIBILITY, not text. A collapsed <details> still holds its text
// in the DOM, so a text assertion on the wrapper passes even when the surface line has been nested
// INSIDE the disclosure — which is exactly the regression that would silently undo this change.
// That false pass was observed by mutation, which is why the line carries its own testid.
import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StreamFeed } from '@/components/cockpit/StreamFeed';
import type { FeedItem } from '@/components/cockpit/StreamFeed';

const LABEL = 'Show the exact model output (raw, for review only)';
const DELIBERATION =
  '## Step 1\nBalance is 0.4 0G. Target is 0.5 0G.\nI must respond with exactly one JSON object.';

function feed(items: FeedItem[]) {
  return render(<StreamFeed connection="open" items={items} />);
}

const healthy: FeedItem = { kind: 'reasoning', id: 'r-1', text: DELIBERATION };

const degenerate: FeedItem = {
  kind: 'reasoning',
  id: 'r-2',
  text: 'Topping up. Topping up. Topping up.',
  meta: { truncated: true, loopCount: 40, decisionSource: 'scavenge', clipped: false },
};

/** The raw deliberation body, addressed structurally: `getByText` normalises whitespace, so a
 *  multi-line deliberation is not findable by its own text. */
function rawBody(): HTMLElement {
  const el = screen.getByTestId('reasoning-raw').querySelector('p');
  if (!el) throw new Error('reasoning-raw has no body paragraph');
  return el as HTMLElement;
}

beforeAll(() => {
  // jsdom has no scrollIntoView (StreamFeed autoscrolls its tail).
  Element.prototype.scrollIntoView = () => undefined;
});

describe('StreamFeed reasoning row — Defect-2 option (a)', () => {
  it('shows the surface line with nothing clicked, and keeps the raw text hidden', () => {
    feed([healthy]);

    // The behavioural claim: readable while the disclosure is CLOSED.
    const surface = screen.getByTestId('reasoning-surface');
    expect(surface).toBeVisible();
    expect(surface).toHaveTextContent("The model's working text while it decided");
    expect(surface).toHaveTextContent('restates its own instructions');
    // It redirects rather than merely demoting — it names the string that carries the real
    // explanation, so a demoted raw affordance does not read as a dead end.
    expect(surface).toHaveTextContent("Agent's own words");

    // The raw deliberation is reachable but not shown. `toBeVisible` is what distinguishes those
    // two; `toHaveTextContent` cannot, since a closed <details> keeps its text in the DOM.
    const details = screen.getByTestId('reasoning-raw').querySelector('details');
    expect(details).not.toHaveAttribute('open');
    expect(rawBody()).toHaveTextContent('I must respond with exactly one JSON object');
    expect(rawBody()).not.toBeVisible();
  });

  it('labels the raw text as a payload, never as a thought process', () => {
    feed([healthy]);
    expect(screen.getByText(LABEL)).toBeVisible();
    // The old label promised interiority over text that is 92% scaffolding. It must be gone, not
    // merely unused: this is the whole of Defect-2.
    expect(screen.queryByText(/thought process/i)).not.toBeInTheDocument();
  });

  it('gives the degenerate branch the SAME label, and keeps its own plain line', () => {
    feed([degenerate]);
    const row = screen.getByTestId('reasoning-degenerate');
    // C-5's plain copy is untouched by this change.
    expect(row).toHaveTextContent('got stuck repeating itself');
    expect(row).toHaveTextContent('40 times');
    // One shared constant: the two branches cannot drift into over-promising in different ways
    // again, which is how "See full thought process" and "See what it managed to say" diverged.
    expect(row.querySelector('summary')).toHaveTextContent(LABEL);
    expect(screen.queryByText(/managed to say/i)).not.toBeInTheDocument();
    // The degenerate branch has its own surface copy, so it does NOT get the healthy line.
    expect(screen.queryByTestId('reasoning-surface')).not.toBeInTheDocument();
  });

  it('leaves the authored rationale as the only full-prominence prose', () => {
    feed([
      healthy,
      {
        kind: 'trace',
        id: 't-1',
        event: {
          type: 'trace',
          kind: 'action',
          seq: 3,
          summary: 'sent 0.01 0G',
          rationale: 'I topped up your beneficiary with 0.01 0G to hold the 0.5 0G floor.',
        },
      },
    ]);
    // This contrast IS the fix: the agent's own words are visible unasked; the model's working
    // text is one dim line plus a closed payload disclosure.
    const voice = screen.getByTestId('trace-agent-voice');
    expect(voice).toBeVisible();
    expect(voice).toHaveTextContent("Agent's own words");
    expect(voice).toHaveTextContent('I topped up your beneficiary');
    expect(rawBody()).not.toBeVisible();
  });
});
