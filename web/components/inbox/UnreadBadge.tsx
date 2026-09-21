// File: web/components/inbox/UnreadBadge.tsx
// Live unread count for the SiteNav "Inbox" item, fed by the shared owner stream. Renders
// nothing at zero — the nav stays quiet when there is nothing for you (00 §1a, not a chore).
'use client';

import { useUnreadAlerts } from '@/lib/use-owner-stream';

export function UnreadBadge() {
  const unread = useUnreadAlerts();
  if (unread === 0) return null;
  return (
    <span
      className="pill pill-accent"
      data-testid="nav-unread-badge"
      aria-label={`${unread} unread alert${unread === 1 ? '' : 's'}`}
      style={{ fontSize: '0.72rem', padding: '0.05rem 0.45rem', marginLeft: '0.3rem' }}
    >
      {unread}
    </span>
  );
}
