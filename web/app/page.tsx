// File: web/app/page.tsx
// Home: one guided entry point (00 §2c). If an agent exists locally, offer its cockpit;
// otherwise the single call to action is creating one.
'use client';

import Link from 'next/link';
import { useAgentId } from '@/lib/use-agent-id';

export default function HomePage() {
  const { agentId } = useAgentId();
  return (
    <div className="wrap-narrow" style={{ paddingBlock: 'clamp(3rem, 8vw, 6rem)' }}>
      <section className="rise" style={{ display: 'grid', gap: '1.2rem', maxWidth: '40rem' }}>
        <p className="eyebrow">LEASH on 0G · phase 1</p>
        <h1 style={{ fontSize: 'var(--text-display)' }}>
          Your AI agent, on a leash you can pull.
        </h1>
        <p style={{ color: 'var(--color-ink-dim)', fontSize: '1.05rem' }}>
          Create an agent with hard spending limits, watch its thinking live, approve or deny
          its big decisions, and cut it off in one move. Everything it does is recorded in a
          private audit trail only you can read.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Link href="/create" className="btn btn-primary">
            Create your agent
          </Link>
          {agentId ? (
            <Link href={`/agents/${agentId}`} className="btn btn-ghost">
              Open your cockpit
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}
