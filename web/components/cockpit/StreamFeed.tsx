// File: web/components/cockpit/StreamFeed.tsx
// Live reasoning + action feed. Reasoning tokens append to the current thought; trace events
// render as feed rows. aria-live polite so screen readers hear new activity without spam.
'use client';

import { useEffect, useRef } from 'react';
import type { StreamEvent } from '@/lib/types';
import { shortAddr, weiToOg } from '@/lib/format';
import { txUrl } from '@/lib/chain';
import type { Hex } from '@/lib/types';
import { Disclosure } from '@/components/ui/Disclosure';

export type FeedItem =
  | { kind: 'reasoning'; text: string; id: string }
  | { kind: 'trace'; event: Extract<StreamEvent, { type: 'trace' }>; id: string }
  | { kind: 'delegation'; event: Extract<StreamEvent, { type: 'delegation' }>; id: string };

export function StreamFeed({
  items,
  connection,
}: {
  items: FeedItem[];
  connection: 'connecting' | 'open' | 'reconnecting' | 'closed';
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

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
        {items.length === 0 ? (
          <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.9rem' }}>
            Waiting for your agent to think. Its reasoning will appear here in real time.
          </p>
        ) : (
          items.map((item) =>
            item.kind === 'reasoning' ? (
              <p key={item.id} className="code" style={{ color: 'var(--color-ink-dim)' }}>
                {item.text}
              </p>
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
                  <a className="link-tx" href={txUrl(item.event.txHash as Hex)} target="_blank" rel="noreferrer">
                    view tx
                  </a>
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
