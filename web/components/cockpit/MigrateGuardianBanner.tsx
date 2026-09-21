// File: web/components/cockpit/MigrateGuardianBanner.tsx
// M-02 carry (spec §3c): when the live on-chain guardian differs from the key LEASH revokes
// with — the SAME condition GuardianPanel already warns on — surface a migrate CTA up top so
// the owner fixes it BEFORE an incident. The fix itself lives in the existing GuardianPanel
// (owner-wallet setGuardian); this banner just steers there. Honest: no new signal invented.
'use client';

import type { Address } from 'viem';
import { shortAddr } from '@/lib/format';

export function MigrateGuardianBanner({
  guardian,
  leashGuardian,
}: {
  /** Live on-chain guardian; undefined = still loading/unavailable (banner stays hidden). */
  guardian: Address | undefined;
  /** The guardian key LEASH revokes with (agent detail leashGuardianAddr). */
  leashGuardian: Address | null | undefined;
}) {
  const mismatch =
    guardian !== undefined &&
    leashGuardian != null &&
    guardian.toLowerCase() !== leashGuardian.toLowerCase();
  if (!mismatch) return null;

  return (
    <section
      aria-label="Guardian needs migrating"
      className="panel"
      data-testid="migrate-guardian-banner"
      style={{ padding: '0.9rem 1rem', display: 'grid', gap: '0.6rem', borderColor: 'rgba(255,184,76,0.45)' }}
    >
      <p style={{ margin: 0, fontSize: '0.9rem' }}>
        <strong>One-click revoke is off for this agent.</strong> Its on-chain guardian (
        {shortAddr(guardian)}) is not the key LEASH revokes with ({shortAddr(leashGuardian)}).
        Migrate to the current guardian key so LEASH can cut this agent off instantly when you
        ask — your wallet can always revoke directly either way.
      </p>
      <a href="#guardian-panel" className="btn btn-primary btn-sm" style={{ justifySelf: 'start' }} data-testid="migrate-guardian-cta">
        Migrate to the new guardian key
      </a>
    </section>
  );
}
