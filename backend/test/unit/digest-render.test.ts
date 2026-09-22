import { describe, it, expect } from 'vitest';
import { DigestService, type Digest } from '../../src/digest/service.js';

// renderText is the phone-facing briefing (00 §2c). These lock in that every
// piece of COMPUTED activity actually reaches the owner — a busy day must not
// silently drop limit changes or cross-agent handoffs.
const svc = new DigestService({
  pool: {} as never,
  chain: {} as never,
  settings: { digestDefaultHourUtc: 8 },
});

function digest(over: Partial<Digest>): Digest {
  return {
    generatedAt: new Date().toISOString(),
    since: new Date(Date.now() - 86_400_000).toISOString(),
    agents: [],
    links: [],
    totals: { spendWei: '0', actions: 0, decisions: 0 },
    empty: false,
    ...over,
  };
}

const agent = (over: Partial<Digest['agents'][number]>): Digest['agents'][number] => ({
  agentId: 'a',
  name: 'Agent',
  status: 'active',
  spendWei: '0',
  balanceWei: '0',
  balanceChangeWei: null,
  actions: 0,
  blocks: 0,
  modifies: 0,
  approvals: { approved: 0, denied: 0, expired: 0 },
  delegationsTerminal: {},
  ...over,
});

describe('DigestService.renderText', () => {
  it('quiet fleet reads calmly', () => {
    expect(svc.renderText(digest({ empty: true }))).toMatch(/quiet/);
  });

  it('surfaces owner limit changes (a modify must not vanish)', () => {
    const out = svc.renderText(
      digest({ agents: [agent({ agentId: 'a1', name: 'Treasury', modifies: 2 })] }),
    );
    expect(out).toContain('2 limit changes you made');
  });

  it('renders cross-agent handoffs with names and direction', () => {
    const out = svc.renderText(
      digest({
        agents: [
          agent({ agentId: 'a1', name: 'Treasury' }),
          agent({ agentId: 'a2', name: 'Payroll' }),
        ],
        links: [{ linkId: 'l1', fromAgentId: 'a1', toAgentId: 'a2', byStatus: { completed: 1, failed: 1 } }],
      }),
    );
    expect(out).toContain('Handoffs between your agents:');
    expect(out).toContain('Treasury → Payroll: 1 completed, 1 failed');
  });

  it('flags blocked requests and unanswered approvals for attention', () => {
    const out = svc.renderText(
      digest({
        agents: [agent({ name: 'Treasury', blocks: 3, approvals: { approved: 0, denied: 0, expired: 1 } })],
        totals: { spendWei: '0', actions: 0, decisions: 1 },
      }),
    );
    expect(out).toMatch(/Worth a look:/);
    expect(out).toContain('3 requests blocked');
  });
});
