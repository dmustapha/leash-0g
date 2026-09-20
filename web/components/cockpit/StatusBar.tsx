// File: web/components/cockpit/StatusBar.tsx
// Status strip: running/paused/revoked, session-expiry countdown, account balance.
'use client';

import { useEffect, useState } from 'react';
import type { AgentDetail } from '@/lib/types';
import { countdown, weiToOg } from '@/lib/format';

const STATUS_PILL: Record<AgentDetail['status'], string> = {
  running: 'pill-allow',
  paused: 'pill-idle',
  revoked: 'pill-deny',
};

export function StatusBar({ detail }: { detail: AgentDetail }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <section aria-label="Agent status" style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
      <span className={`pill ${STATUS_PILL[detail.status]}`} data-testid="status-pill">
        {detail.status}
      </span>
      <span className="badge" data-testid="session-countdown">
        session {countdown(detail.sessionExpiry, now)}
      </span>
      <span className="badge">{weiToOg(detail.accountBalance)} 0G in account</span>
    </section>
  );
}
