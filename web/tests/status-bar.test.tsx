// File: web/tests/status-bar.test.tsx
// Server-verified pill (Gate-② parity): rendered from GET /traces chainVerified, labeled
// honestly as LEASH's own check, with a failure variant and no pill while unknown.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from '@/components/cockpit/StatusBar';
import type { AgentDetail } from '@/lib/types';

const DETAIL: AgentDetail = {
  status: 'running',
  policy: {
    perTransferCapWei: '10000000000000000',
    windowCapWei: '50000000000000000',
    windowSeconds: 86400,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
    allowlist: [],
  },
  accountBalance: '250000000000000000',
  sessionExpiry: Math.floor(Date.now() / 1000) + 7 * 86400,
  addresses: {
    account: '0x1111111111111111111111111111111111111111',
    sessionKey: '0x2222222222222222222222222222222222222222',
    owner: '0x3333333333333333333333333333333333333333',
  },
};

describe('StatusBar server-verified pill', () => {
  it('renders the pill with an honest tooltip when chainVerified is true', () => {
    render(<StatusBar detail={DETAIL} chainVerified />);
    const pill = screen.getByTestId('server-verified-pill');
    expect(pill).toHaveTextContent('server-verified');
    expect(pill).toHaveAttribute('title', expect.stringContaining("LEASH's own integrity check"));
    expect(pill).toHaveAttribute('title', expect.stringContaining('Audit page'));
  });

  it('renders the failure pill when chainVerified is false', () => {
    render(<StatusBar detail={DETAIL} chainVerified={false} />);
    expect(screen.getByTestId('server-verify-failed-pill')).toHaveTextContent(/check failed/i);
    expect(screen.queryByTestId('server-verified-pill')).not.toBeInTheDocument();
  });

  it('renders no pill while the flag is unknown', () => {
    render(<StatusBar detail={DETAIL} />);
    expect(screen.queryByTestId('server-verified-pill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('server-verify-failed-pill')).not.toBeInTheDocument();
  });
});
