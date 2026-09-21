// File: web/tests/migrate-guardian-banner.test.tsx
// M-02 carry: the migrate CTA shows on exactly the GuardianPanel mismatch condition — live
// guardian ≠ the key LEASH revokes with — and steers to the guardian panel. Plus P3C-6(ii):
// StreamFeed renders decoded errors as plain language with the raw name behind disclosure.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Address } from 'viem';
import { MigrateGuardianBanner } from '@/components/cockpit/MigrateGuardianBanner';
import { StreamFeed } from '@/components/cockpit/StreamFeed';

const LEASH_KEY = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address;
const OTHER = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address;

describe('MigrateGuardianBanner', () => {
  it('shows the migrate CTA when the on-chain guardian is not the LEASH key', () => {
    render(<MigrateGuardianBanner guardian={OTHER} leashGuardian={LEASH_KEY} />);
    expect(screen.getByTestId('migrate-guardian-banner')).toBeInTheDocument();
    expect(screen.getByTestId('migrate-guardian-cta')).toHaveAttribute('href', '#guardian-panel');
    expect(screen.getByTestId('migrate-guardian-cta')).toHaveTextContent(
      'Migrate to the new guardian key',
    );
  });

  it('stays hidden when they match (case-insensitive), while loading, or with no LEASH key', () => {
    const { rerender } = render(
      <MigrateGuardianBanner
        guardian={LEASH_KEY.toLowerCase() as Address}
        leashGuardian={LEASH_KEY}
      />,
    );
    expect(screen.queryByTestId('migrate-guardian-banner')).not.toBeInTheDocument();
    rerender(<MigrateGuardianBanner guardian={undefined} leashGuardian={LEASH_KEY} />);
    expect(screen.queryByTestId('migrate-guardian-banner')).not.toBeInTheDocument();
    rerender(<MigrateGuardianBanner guardian={OTHER} leashGuardian={null} />);
    expect(screen.queryByTestId('migrate-guardian-banner')).not.toBeInTheDocument();
  });
});

describe('StreamFeed decoded errors (P3C-6 ii)', () => {
  it('renders the plain copy with the raw errorName behind a disclosure', () => {
    // jsdom has no scrollIntoView (StreamFeed autoscrolls its tail).
    Element.prototype.scrollIntoView = () => undefined;
    render(
      <StreamFeed
        connection="open"
        items={[
          {
            kind: 'trace',
            id: 't-1',
            event: {
              type: 'trace',
              kind: 'error',
              seq: 7,
              summary: 'execute refused',
              decoded: {
                errorName: 'OverWindowCap',
                args: [],
                plain:
                  'That would go over the spending window cap — the window has to reset (or the owner raise it) first.',
              },
            },
          },
        ]}
      />,
    );
    const decoded = screen.getByTestId('trace-decoded');
    expect(decoded).toHaveTextContent('That would go over the spending window cap');
    // Raw name present but tucked behind the (closed) disclosure.
    expect(decoded).toHaveTextContent('OverWindowCap');
    expect(decoded.querySelector('details')).not.toHaveAttribute('open');
  });
});
