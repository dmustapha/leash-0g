// File: web/components/SiteNav.tsx
// LEASH v1 wordmark + Phase-1 nav (create / cockpit / audit) + wallet connect state.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOwnerWallet } from '@/lib/owner-wallet';
import { useAgentId } from '@/lib/use-agent-id';
import { shortAddr } from '@/lib/format';
import { UnreadBadge } from '@/components/inbox/UnreadBadge';

export function Wordmark({ height = 26 }: { height?: number }) {
  return (
    <Link href="/app" aria-label="LEASH console home" style={{ display: 'inline-flex', alignItems: 'center' }}>
      <svg height={height} viewBox="0 0 300 80" role="img" aria-label="LEASH" style={{ display: 'block', width: 'auto' }}>
        <g fill="var(--color-ink, #f4f4ef)" fontFamily="var(--font-display), 'Clash Display', sans-serif" fontWeight={700}>
          <text x="44" y="52" fontSize="46" letterSpacing="1">LEASH</text>
        </g>
        <g fill="none" stroke="var(--color-accent, #c6f24d)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="20" cy="60" r="9" />
          <path d="M27 55 l6 -4" stroke="#d6ff6a" />
          <path d="M29 60 C 60 66, 120 66, 210 62 C 240 60, 250 58, 258 56" />
          <path d="M258 56 c 8 -2 12 4 8 10 c -3 4 -9 3 -10 -2" />
        </g>
      </svg>
    </Link>
  );
}

export default function SiteNav() {
  const path = usePathname();
  const wallet = useOwnerWallet();
  const { agentId } = useAgentId();

  // The marketing landing (route `/`) renders its own minimal header — hide the app nav.
  if (path === '/') return null;

  const links: { href: string; label: string; badge?: boolean }[] = [
    { href: '/app', label: 'Agents' },
    { href: '/create', label: 'Create agent' },
    { href: '/jobs', label: 'Jobs' },
    { href: '/links', label: 'Links' },
    { href: '/inbox', label: 'Inbox', badge: true },
    { href: '/digest', label: 'Digest' },
    { href: '/settings/alerts', label: 'Alerts' },
    // Phase-5 note (D-A4): `agentId` is a localStorage convenience pointer to the last-created
    // agent; it can go stale if that agent is later revoked/deleted (the Cockpit/Audit links
    // would then 404 into the cockpit's own load-error state, which is legible, not silent).
    // Fully resolving requires a fetch-to-validate on every nav render, which is disproportionate
    // for a shortcut whose failure mode is already handled downstream — deferred. The `/app` fleet
    // list is always the authoritative, never-stale entry to any live agent.
    ...(agentId
      ? [
          { href: `/agents/${agentId}`, label: 'Cockpit' },
          { href: `/agents/${agentId}/audit`, label: 'Audit' },
        ]
      : []),
  ];

  return (
    <header className="nav">
      <Wordmark />
      <span style={{ flex: 1 }} />
      <nav style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }} aria-label="Primary">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="nav-link" aria-current={path === l.href ? 'page' : undefined}>
            {l.label}
            {l.badge ? <UnreadBadge /> : null}
          </Link>
        ))}
        {wallet.ready && !wallet.authenticated ? (
          <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: '0.5rem' }} onClick={wallet.login}>
            Connect wallet
          </button>
        ) : wallet.address ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: '0.5rem', fontFamily: 'var(--font-mono)' }}
            onClick={wallet.logout}
            title="Disconnect"
          >
            {shortAddr(wallet.address)}
          </button>
        ) : null}
      </nav>
    </header>
  );
}
