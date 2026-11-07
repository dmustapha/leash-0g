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

const native = (wei: string): Digest['totals']['spendByAsset'] => (wei === '0' ? [] : [{ chainId: 16602, token: null, symbol: null, decimals: null, amountWei: wei }]);

function digest(over: Partial<Digest>): Digest {
  return {
    generatedAt: new Date().toISOString(),
    since: new Date(Date.now() - 86_400_000).toISOString(),
    agents: [],
    links: [],
    lifecycle: { created: [], onboarded: [], linksCreated: [] },
    totals: { spendWei: '0', spendByAsset: [], actions: 0, decisions: 0, jobFees: { count: 0, byToken: {} } },
    empty: false,
    ...over,
  };
}

const agent = (over: Partial<Digest['agents'][number]>): Digest['agents'][number] => ({
  agentId: 'a',
  name: 'Agent',
  status: 'active',
  spendWei: '0',
  spendByAsset: [],
  goalAsset: null,
  chainId: 16602,
  jobFees: { count: 0, byToken: {} },
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

  it('§8: labels job-fee settlements distinctly from native transfers', () => {
    const out = svc.renderText(
      digest({
        agents: [agent({ agentId: 'r1', name: 'Requester', jobFees: { count: 2, byToken: { '0xbeea': '3000000' } } })],
        totals: { spendWei: '0', spendByAsset: native('0'), actions: 0, decisions: 0, jobFees: { count: 2, byToken: { '0xbeea': '3000000' } } },
      }),
    );
    // job fees are named as job fees, never rolled into a native "0G total"
    expect(out).toContain('2 job fees settled');
    expect(out).toContain('settled 2 job fees');
    expect(out).not.toMatch(/0G total/);
  });

  it('P5C-4: surfaces the job-fee AMOUNT (with symbol) when the token meta is known', () => {
    const out = svc.renderText(
      digest({
        agents: [agent({ agentId: 'r1', name: 'Requester', jobFees: { count: 1, byToken: { '0xbeea': '2000000' }, feeLabel: '2 TestUSD' } })],
        totals: { spendWei: '0', spendByAsset: native('0'), actions: 0, decisions: 0, jobFees: { count: 1, byToken: { '0xbeea': '2000000' }, feeLabel: '2 TestUSD' } },
      }),
    );
    // The amount reaches the owner's briefing, not just a bare count (P5C-4).
    expect(out).toContain('1 job fee settled (2 TestUSD)');
    expect(out).toContain('settled 1 job fee (2 TestUSD)');
  });

  it('§8: the real settlement shape (fee + owner decision, no native transfer) keeps BOTH clauses', () => {
    // actions=0, decisions>=1, jobFees>=1 — the exact digest the deployed job
    // drill produces. The lead must name the job fee AND the owner decision.
    const out = svc.renderText(
      digest({
        agents: [
          agent({
            agentId: 'r1',
            name: 'Requester',
            approvals: { approved: 1, denied: 0, expired: 0 },
            jobFees: { count: 1, byToken: { '0xbeea': '2000000' } },
          }),
        ],
        totals: { spendWei: '0', spendByAsset: native('0'), actions: 0, decisions: 1, jobFees: { count: 1, byToken: { '0xbeea': '2000000' } } },
      }),
    );
    expect(out).toContain('1 job fee settled');
    expect(out).toContain('1 decision came to you');
    expect(out).not.toMatch(/0G total/);
  });

  it('flags blocked requests and unanswered approvals for attention', () => {
    const out = svc.renderText(
      digest({
        agents: [agent({ name: 'Treasury', blocks: 3, approvals: { approved: 0, denied: 0, expired: 1 } })],
        totals: { spendWei: '0', spendByAsset: native('0'), actions: 0, decisions: 1, jobFees: { count: 0, byToken: {} } },
      }),
    );
    expect(out).toMatch(/Worth a look:/);
    expect(out).toContain('3 requests blocked');
  });

  // B-6: creates, onboards and new links were invisible in the digest.
  it('surfaces created agents, chain onboards and new links (B-6)', () => {
    const out = svc.renderText(
      digest({
        agents: [
          agent({ agentId: 'a1', name: 'Treasury' }),
          agent({ agentId: 'a2', name: 'Band Hero' }),
        ],
        lifecycle: {
          created: [{ agentId: 'a2', name: 'Band Hero' }],
          onboarded: [{ agentId: 'a1', name: 'Treasury', chainId: 84532 }],
          linksCreated: [{ linkId: 'l1', fromAgentId: 'a1', toAgentId: 'a2' }],
        },
      }),
    );
    expect(out).toContain('New: Band Hero');
    expect(out).toContain('Treasury onboarded onto chain 84532');
    expect(out).toContain('New links between your agents:');
    expect(out).toContain('🔗 Treasury → Band Hero');
  });

  it('tolerates persisted pre-B-6 digests without a lifecycle field', () => {
    const legacy = digest({});
    delete (legacy as Partial<Digest>).lifecycle;
    expect(() => svc.renderText(legacy)).not.toThrow();
  });
});
