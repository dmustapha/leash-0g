// File: web/components/shell/AppShell.tsx
// STAGE G-2.1 — the console SHELL, imported from console.html:401-434 and wrapping every
// console route. Replaces the SiteNav placeholder (a bare horizontal header) with the
// artifact's grouped left rail + sticky glass topbar + ⌘K palette.
//
// Pathname-aware: the marketing route `/` renders its OWN full-page chrome (LandingRoot),
// so here it passes through as a bare `<main id="main">`. Every other route gets the grid
// shell. `#main` stays the primary landmark in both branches (the marketing skip-link
// targets it).
//
// RECONCILED to the real app (same discipline as G-2.0 — import the design, bind the data
// to what shipped):
//   · the artifact's `data-view` toggles become real Next routes with `aria-current="page"`.
//   · ruling 3: Verdicts + Policies are NOT standalone items — they fold into the cockpit
//     (G-2.5), so the STREAM group and the Policies item are absent. Nav is MONITOR /
//     OPERATE / TRUST, with the live-only routes Create and Alerts placed in their nearest
//     group (Dami-ruled "ruling-3 faithful", 2026-10-19).
//   · the account footer prints the REAL owner (Privy wallet short-address) or the connect
//     control — never the artifact's invented ENS `org.leash.eth`.
//   · obligation (b): Create (←bind.html) and Alerts (←cockpit patterns) icons are derived,
//     marked at their site; their surfaces are reskinned in G-2.3 / G-2.5.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { useAgentId } from '@/lib/use-agent-id';
import { shortAddr } from '@/lib/format';
import { UnreadBadge } from '@/components/inbox/UnreadBadge';
import ThemeToggle from '@/components/ThemeToggle';
import CommandPalette from '@/components/shell/CommandPalette';
import LiveIndicator from '@/components/shell/LiveIndicator';

type Item = {
  key: string;
  label: string;
  title: string;
  sub: string;
  href: string;
  icon: React.ReactNode;
  badge?: boolean;
  /** Needs a chosen agent; with none it is shown but inert (S-6: it used to link back to Fleet, same as another item). */
  needsAgent?: boolean;
  match: (p: string) => boolean;
};

const I = {
  fleet: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8h6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 4.5 8 9l6-4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  digest: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3h10M3 7h10M3 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  cockpit: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".5" />
    </svg>
  ),
  jobs: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 3v-1M10.5 3v-1M2.5 6h11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  links: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 8a2.5 2.5 0 0 1 2.5-2.5H10M10 8a2.5 2.5 0 0 1-2.5 2.5H6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  audit: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  // DERIVED (obligation b) — no artifact icon; a plain mark for the live-only /create route.
  create: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  // DERIVED (obligation b) — no artifact icon; a bell for the live-only /settings/alerts route.
  alerts: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.2 3.8-1.2 3.8h9.4s-1.2-.8-1.2-3.8A3.5 3.5 0 0 0 8 2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6.6 11.6a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};

const onAgents = (p: string) => p.startsWith('/agents/');

function buildGroups(agentId: string | null): { name: string; items: Item[] }[] {
  const cockpitHref = agentId ? `/agents/${agentId}` : '/app';
  const auditHref = agentId ? `/agents/${agentId}/audit` : '/app';
  return [
    {
      name: 'Monitor',
      items: [
        { key: 'fleet', label: 'Fleet', title: 'Fleet', sub: 'your agents', href: '/app', icon: I.fleet, match: (p) => p === '/app' },
        { key: 'inbox', label: 'Inbox', title: 'Inbox', sub: 'approvals & alerts', href: '/inbox', icon: I.inbox, badge: true, match: (p) => p.startsWith('/inbox') },
        { key: 'digest', label: 'Digest', title: 'Digest', sub: 'daily summary', href: '/digest', icon: I.digest, match: (p) => p.startsWith('/digest') },
      ],
    },
    {
      name: 'Operate',
      items: [
        { key: 'cockpit', label: 'Cockpit', title: 'Cockpit', sub: 'one agent, live', href: cockpitHref, needsAgent: !agentId, icon: I.cockpit, match: (p) => onAgents(p) && !p.endsWith('/audit') },
        { key: 'jobs', label: 'Jobs', title: 'Jobs', sub: 'delegated work', href: '/jobs', icon: I.jobs, match: (p) => p.startsWith('/jobs') },
        { key: 'links', label: 'Links', title: 'Links', sub: 'agent-to-agent channels', href: '/links', icon: I.links, match: (p) => p.startsWith('/links') },
        { key: 'create', label: 'Create', title: 'Create agent', sub: 'bind a new leash', href: '/create', icon: I.create, match: (p) => p === '/create' },
      ],
    },
    {
      name: 'Trust',
      items: [
        { key: 'audit', label: 'Audit', title: 'Audit', sub: 'the hash-chained record', href: auditHref, needsAgent: !agentId, icon: I.audit, match: (p) => onAgents(p) && p.endsWith('/audit') },
        { key: 'alerts', label: 'Alerts', title: 'Alerts', sub: 'delivery preferences', href: '/settings/alerts', icon: I.alerts, match: (p) => p.startsWith('/settings/alerts') },
      ],
    },
  ];
}

const BrandMark = () => (
  <svg width="22" height="22" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="8" cy="13" r="5" fill="none" stroke="var(--accent)" strokeWidth="2" />
    <path d="M13 13 H24 M24 9 v8" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? '';
  const wallet = useOwnerWallet();
  const { agentId } = useAgentId();

  // Marketing `/` brings its own chrome; pass through as the primary landmark. The LIVE
  // indicator (and its owner-stream subscription) lives in <LiveIndicator/>, rendered only in
  // the console branch below — so `/` never opens a stream.
  if (path === '/') return <main id="main">{children}</main>;

  const groups = buildGroups(agentId);
  const active = groups.flatMap((g) => g.items).find((it) => it.match(path));

  return (
    <div className="console-shell">
      <aside>
        <Link className="brand" href="/app" aria-label="LEASH console home">
          <BrandMark />
          <span className="brand-text">LEASH</span>
        </Link>
        <nav aria-label="Console sections" style={{ display: 'contents' }}>
          {groups.map((group) => (
            <div key={group.name} style={{ display: 'contents' }}>
              <p className="nav-group">{group.name}</p>
              {group.items.map((it) => {
                const current = it.match(path);
                if (it.needsAgent) {
                  return (
                    <span key={it.key} className="navitem" aria-disabled="true" title="Open an agent from Fleet first">
                      {it.icon}
                      <span>{it.label}</span>
                    </span>
                  );
                }
                return (
                  <Link
                    key={it.key}
                    href={it.href}
                    className="navitem"
                    aria-current={current ? 'page' : undefined}
                  >
                    {it.icon}
                    <span>{it.label}</span>
                    {it.badge ? <UnreadBadge /> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="spacer" />
        <div className="acct">
          Owner
          {wallet.address ? (
            <button type="button" className="acct-btn" onClick={wallet.logout} title="Disconnect">
              {shortAddr(wallet.address)}
            </button>
          ) : wallet.ready && !wallet.authenticated ? (
            <button type="button" className="acct-btn" onClick={wallet.login}>
              Connect wallet
            </button>
          ) : (
            <span className="mono">—</span>
          )}
        </div>
      </aside>

      <div className="console-main">
        <header className="top">
          <div className="crumb">
            <h1>{active?.title ?? 'LEASH'}</h1>
            {active?.sub ? <span className="sub">{active.sub}</span> : null}
          </div>
          <div className="right">
            <ThemeToggle />
            <CommandPalette />
            {/* LIVE indicator — bound to the REAL owner-stream transport, in its own component
                so the stream subscription never runs on the marketing `/` route. */}
            <LiveIndicator />
          </div>
        </header>
        <main id="main" className="console-view">
          {children}
        </main>
      </div>
    </div>
  );
}
