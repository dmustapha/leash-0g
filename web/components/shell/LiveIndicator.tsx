// File: web/components/shell/LiveIndicator.tsx
// The topbar LIVE dot, bound to the REAL owner-stream transport (use-owner-stream → lib/sse.ts).
// Extracted into its own component so `useOwnerStreamStatus()` is called ONLY inside the console
// shell — never on the marketing `/` route (AppShell returns early there, and opening an SSE
// connection with no subscriber on a page nobody streams from would violate the
// no-stream-without-a-subscriber rule). Renders nothing until there is an authenticated owner —
// a standing "LIVE" with no stream behind it would be a false claim.
'use client';

import { useOwnerWallet } from '@/lib/owner-wallet';
import { useOwnerStreamStatus } from '@/lib/use-owner-stream';

export default function LiveIndicator() {
  const wallet = useOwnerWallet();
  const streamStatus = useOwnerStreamStatus();

  if (!wallet.authenticated) return null;

  const settling = streamStatus === 'connecting' || streamStatus === 'reconnecting';
  return (
    <span
      className={`live${settling ? ' settling' : ''}`}
      role="status"
      aria-live="polite"
      title={streamStatus === 'open' ? 'Owner event stream connected' : 'Reconnecting to the owner event stream'}
    >
      <span className="live-dot" aria-hidden="true" />
      LIVE
      {settling ? <span className="live-sub"> · rail settling</span> : null}
    </span>
  );
}
