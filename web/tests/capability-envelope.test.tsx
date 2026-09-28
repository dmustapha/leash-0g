// File: web/tests/capability-envelope.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapabilityEnvelope } from '@/components/cockpit/CapabilityEnvelope';
import type { CapabilityEnvelopeView } from '@/lib/types';

const FULL: CapabilityEnvelopeView = {
  grants: [
    {
      id: 'g-1',
      agentId: 'agent-1',
      ownerAddr: '0x3333333333333333333333333333333333333333',
      target: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      selector: '0x38ed1739',
      recipientMode: 'self',
      spenderSet: [],
      perCallCap: '100000000',
      windowCapCall: '500000000',
      codehash: null,
      source: 'preset',
      status: 'active',
      txHash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  presets: [{ presetKey: 'defi_trader' }],
  recentRequests: [
    {
      id: 'req-1',
      callHash: ('0x' + '1'.repeat(64)) as `0x${string}`,
      status: 'approved_once',
      approvalId: 'apr-1',
      novelty: ['new_target'],
      decoded: {
        label: 'UNVERIFIED',
        target: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        selector: '0x38ed1739',
        signature: 'function swap(...)',
        value: '0',
        humanReadable: 'Swap on the router',
        novelty: ['new_target'],
      },
    },
  ],
};

const EMPTY: CapabilityEnvelopeView = { grants: [], presets: [], recentRequests: [] };

describe('CapabilityEnvelope', () => {
  it('renders standing grants, applied presets, and recent JIT decisions', () => {
    render(<CapabilityEnvelope envelope={FULL} />);
    expect(screen.getByTestId('grant-g-1')).toBeInTheDocument();
    expect(screen.getByText(/DeFi trader/i)).toBeInTheDocument();
    expect(screen.getByTestId('recent-req-1')).toBeInTheDocument();
  });

  it('renders an empty state when nothing is granted', () => {
    render(<CapabilityEnvelope envelope={EMPTY} />);
    expect(screen.getByText(/can't make any custom contract calls yet/i)).toBeInTheDocument();
  });

  it('renders quarantined recent-request intent as plain text', () => {
    const xss: CapabilityEnvelopeView = {
      ...FULL,
      recentRequests: [
        { ...FULL.recentRequests[0]!, decoded: { ...FULL.recentRequests[0]!.decoded, humanReadable: '<b>x</b>' } },
      ],
    };
    const { container } = render(<CapabilityEnvelope envelope={xss} />);
    expect(screen.getByTestId('recent-req-1').textContent).toContain('<b>x</b>');
    expect(container.querySelector('b')).toBeNull();
  });
});
