// File: web/components/cockpit/StreamFeed.tsx
// Live reasoning + action feed. Reasoning tokens append to the current thought; trace events
// render as feed rows. aria-live polite so screen readers hear new activity without spam.
'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { StreamEvent } from '@/lib/types';
import { shortAddr, weiToOg } from '@/lib/format';
import { txUrl } from '@/lib/chain';
import { networkTxUrl } from '@/lib/networks';
import type { Hex } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';

/**
 * AQ-A0-Q2VIS Defect-2, option (a): ONE label for both reasoning branches.
 *
 * It is a payload label, not a promise of an explanation. `Show the exact …` is the
 * established family-A form for a verbatim machine payload (CapabilityEnvelope,
 * CapabilityGrant, CapabilityDecisionCard, SigningGrantPanel); `(raw, for review only)`
 * is the family-D untrusted-artefact qualifier borrowed from JobLifecycle's
 * "Deliverable (untrusted — for review only)".
 *
 * It says "model output" rather than "deliberation" on purpose. A second, unfixed
 * producer (`backend/src/jobs/graph.ts` reasoning channel for the provider/evaluator/
 * requester roles) still emits decision JSON on this same channel, so the only wording
 * that is honest over EVERY payload this branch can receive is the generic one.
 *
 * Hoisted to a module constant because the two branches drifting apart is exactly how
 * the old pair of labels ("See full thought process" / "See what it managed to say")
 * came to over-promise in different ways.
 */
const RAW_MODEL_OUTPUT_LABEL = 'Show the exact model output (raw, for review only)';

export type FeedItem =
  | {
      kind: 'reasoning';
      text: string;
      id: string;
      /** AQ-A0-Q2VIS D-2: cycle health, so a degenerate cycle degrades instead of dumping. */
      meta?: Extract<StreamEvent, { type: 'reasoning' }>['meta'];
    }
  | { kind: 'trace'; event: Extract<StreamEvent, { type: 'trace' }>; id: string }
  | { kind: 'delegation'; event: Extract<StreamEvent, { type: 'delegation' }>; id: string };

export function StreamFeed({
  items,
  connection,
  chainId,
}: {
  items: FeedItem[];
  connection: 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** F-11: the agent's home chain — explorer links must point at ITS explorer. */
  chainId?: number;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  // Q5 (presentation): drop the raw gateway `inference` rows (summary = the raw
  // observation JSON) from the owner feed — the reasoning disclosure restates the
  // observation in plain terms and the decision rows carry the outcome + why. The
  // inference record is unchanged in the audit trail.
  const shown = useMemo(
    () => items.filter((it) => !(it.kind === 'trace' && it.event.kind === 'inference')),
    [items],
  );

  return (
    <section aria-label="Live agent activity" className="card" style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.8rem 1rem', borderBottom: '1px solid var(--color-line-soft)' }}>
        <h2 style={{ fontSize: '1rem' }}>Live activity</h2>
        <span style={{ flex: 1 }} />
        {connection === 'open' ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.78rem', color: 'var(--color-allow)' }}>
            <span className="dot-live" aria-hidden="true" /> live
          </span>
        ) : (
          <span className="pill pill-idle" data-testid="stream-status">
            {connection === 'closed' ? 'offline' : connection}
          </span>
        )}
      </header>
      <div
        aria-live="polite"
        style={{ overflowY: 'auto', maxHeight: '28rem', padding: '0.9rem 1rem', display: 'grid', gap: '0.7rem', alignContent: 'start' }}
        data-testid="stream-feed"
      >
        {shown.length === 0 ? (
          <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.9rem' }}>
            Waiting for your agent to think. Its reasoning will appear here in real time.
          </p>
        ) : (
          shown.map((item) =>
            item.kind === 'reasoning' ? (
              // Q5 (presentation): the raw model deliberation is kept available for
              // transparency/online-eval but NOT dumped at the owner — plain surface,
              // raw behind progressive disclosure (§2c), mirroring the decoded-error pattern.
              //
              // AQ-A0-Q2VIS Defect-2, Dami's ruling = option (a): change what the cockpit SHOWS,
              // not what the model is asked to produce. A measured 80-call probe found 92/100
              // deliberations contain prompt scaffolding — the model reciting its own instruction
              // contract — and the prompt-scoping fix removed only 8 of the 92, so wording at the
              // producer is a weak lever. Evidence:
              // docs/evidence/aq-a0-q2vis/M-DEF2-SCOPE-AB-VERDICT.md (0g-fleet).
              //
              // So this row is a DEMOTION IN PLACE: one dim sentence on the surface that says what
              // the text actually is, and the text itself behind a label that calls it a raw
              // payload (RAW_MODEL_OUTPUT_LABEL). The owner's explanation is the authored
              // `rationale` — "Agent's own words" on each action row below, which measures clean
              // (100% present, 100% anchored, 0 jargon leaks). Leaving the full-prominence prose to
              // that line IS the fix; the contrast is the deliverable.
              //
              // §9-D stands: the server is NOT an editor. Do not add a lexical filter or scrubber
              // over deliberation prose, here or upstream. The scaffolding stays visible once the
              // owner opens the disclosure — that is correct, because the label said raw.
              //
              // D-2 stands too: no producer change. `text` is the model's DELIBERATION (before D-2
              // this channel carried the decision JSON, which is F-0b-34/35 and why Q2 could not be
              // graded), and the scavenge fallback is not deleted.
              <div key={item.id} style={{ fontSize: '0.84rem' }}>
                {item.meta?.truncated ? (
                  // C-5: a degenerate cycle restated its answer until it hit the token cap. Say so
                  // in plain language; never render the repetition as if it were thinking.
                  <div style={{ display: 'grid', gap: '0.35rem' }} data-testid="reasoning-degenerate">
                    <span style={{ color: 'var(--color-ink-dim)' }}>
                      This agent got stuck repeating itself while thinking
                      {item.meta.loopCount > 0 ? ` (${item.meta.loopCount} times)` : ''} and its
                      thinking was cut off. Its decision was still read correctly.
                    </span>
                    <Disclosure label={RAW_MODEL_OUTPUT_LABEL}>
                      <p className="code" style={{ color: 'var(--color-ink-dim)', whiteSpace: 'pre-wrap' }}>
                        {item.text}
                      </p>
                    </Disclosure>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: '0.35rem' }} data-testid="reasoning-raw">
                    {/* The surface line. It MUST stay a sibling of the Disclosure, never a child:
                        it is the only thing that sets expectations before the owner opens the raw
                        text, so nesting it would make it invisible exactly when it is needed. Its
                        own testid exists so the e2e can assert VISIBILITY — a collapsed <details>
                        still holds its text in the DOM, so a text assertion cannot tell the two
                        apart (this was caught by mutation, not by review). The third sentence
                        turns the demotion into a redirection by naming the string below. */}
                    <span style={{ color: 'var(--color-ink-dim)' }} data-testid="reasoning-surface">
                      The model&apos;s working text while it decided. Not written for you, and it
                      often restates its own instructions. The agent&apos;s explanation is the
                      &ldquo;Agent&apos;s own words&rdquo; line on each action below.
                    </span>
                    <Disclosure label={RAW_MODEL_OUTPUT_LABEL}>
                      <p className="code" style={{ color: 'var(--color-ink-dim)', whiteSpace: 'pre-wrap' }}>
                        {item.text}
                      </p>
                    </Disclosure>
                  </div>
                )}
              </div>
            ) : item.kind === 'delegation' ? (
              <div key={item.id} className="panel" style={{ padding: '0.6rem 0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className={`pill ${item.event.status === 'completed' ? 'pill-allow' : item.event.status === 'failed' || item.event.status === 'declined' ? 'pill-deny' : 'pill-accent'}`}>
                  handoff
                </span>
                <span style={{ fontSize: '0.86rem' }}>
                  {item.event.direction === 'outbound' ? 'asked another agent' : 'was asked'} · {item.event.kind} · {item.event.status.replace('_', ' ')}
                </span>
              </div>
            ) : (
              <div key={item.id} className="panel" style={{ padding: '0.6rem 0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className={`pill ${item.event.kind === 'block' || item.event.kind === 'revoke' || item.event.kind === 'error' ? 'pill-deny' : item.event.kind === 'action' ? 'pill-allow' : 'pill-idle'}`}>
                  {item.event.kind}
                </span>
                <span style={{ fontSize: '0.86rem' }}>
                  {item.event.summary ??
                    (item.event.valueWei && item.event.to
                      ? `${weiToOg(item.event.valueWei)} 0G → ${shortAddr(item.event.to)}`
                      : `trace #${item.event.seq}`)}
                </span>
                {item.event.txHash ? (
                  <a className="link-tx" href={(chainId !== undefined ? networkTxUrl(chainId, item.event.txHash as string) : null) ?? txUrl(item.event.txHash as Hex)} target="_blank" rel="noreferrer">
                    view tx
                  </a>
                ) : null}
                {/* AQ-A0-Q2VIS D-4 owner layer. The pill + `summary` above are server-composed from
                    the VERIFIED decision — that is the authoritative "what happened". This line is
                    the agent's OWN WORDS, attributed and quoted so it reads as the agent speaking
                    rather than as a fact the app is asserting. It is deliberately NOT gated on the
                    backend's agreement check: three Gate-② rounds showed no lexical check can
                    certify that prose entails a decision, so nothing here is presented as verified.

                    PROVENANCE (live-pass fix). `rationale` is the ONLY field the agent authors for
                    the owner. `reason` is NOT: the runtime synthesizes stand_down / failed
                    decisions with a server-written reason ("spending window exhausted — standing
                    down until it resets", "boundary active (…)", "tool rail disappeared before
                    execution", …), and the earlier `?? reason` fallback quoted that server text
                    back to the owner as the agent's own words. The old `why === summary` guard only
                    caught it where the two strings matched exactly, so every reason that
                    summarize() prefixed ("stood down: …") sailed through — the live pass caught the
                    window-exhaustion row saying the same sentence twice, once as fact and once as
                    quote. There is no fallback now: when the agent authored nothing, the line is
                    absent. Silence is correct; a quote the agent never said is not. */}
                {item.event.rationale ? (
                  <span
                    style={{ flexBasis: '100%', fontSize: '0.84rem', color: 'var(--color-ink-dim)' }}
                    data-testid="trace-agent-voice"
                  >
                    <span style={{ fontStyle: 'normal', opacity: 0.75 }}>Agent&apos;s own words: </span>
                    <q>{item.event.rationale}</q>
                  </span>
                ) : null}
                {item.event.decoded ? (
                  // P3C-6(ii): plain language on the surface, raw error name behind
                  // progressive disclosure — never a raw selector.
                  <div style={{ flexBasis: '100%', display: 'grid', gap: '0.35rem' }} data-testid="trace-decoded">
                    <span style={{ fontSize: '0.84rem', color: 'var(--color-ink-dim)' }}>
                      {item.event.decoded.plain}
                    </span>
                    <Disclosure label="Technical detail">
                      Contract error: <code className="code">{item.event.decoded.errorName}</code>
                    </Disclosure>
                  </div>
                ) : null}
              </div>
            ),
          )
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
