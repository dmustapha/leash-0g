import { describe, it, expect } from 'vitest';
import type { TraceRecord } from '../../src/types.js';
import type { AgentGoal } from '../../src/types.js';
import {
  buildCycleMemory,
  capabilitiesKey,
  classifyOutcome,
  computeActionPossible,
  computeDelta,
  deriveCycleFlags,
  renderCycleMemoryDisplay,
  snapshotsDiffer,
  type CycleMemory,
  type CycleRecord,
  type SenseSnapshot,
} from '../../src/runtime/cycle-memory.js';
import { buildReasonRequest, type ReasonContext } from '../../src/runtime/prompt.js';

// AQ-A1 D-1/D-2/D-3 — the server-composed carry, boundary instruments, budget, and prompt wiring.

const BENE = '0xF00F000000000000000000000000000000000b0Be';
const now = 1_000_000;

const pol = (over: Partial<SenseSnapshot & Record<string, unknown>> = {}) => ({
  perTransferCapWei: '20000000000000000',
  windowCapWei: '100000000000000000',
  windowSeconds: 3600,
  expiresAt: now + 86400,
  allowlist: [BENE.toLowerCase()],
  revoked: false,
  spentInWindowWei: '0',
  remainingWindowWei: '100000000000000000',
  windowResetsAtUnix: now + 3600,
  ...over,
});

const treasuryGoal = { type: 'treasury', beneficiary: BENE, targetBalanceWei: '50000000000000000', topUpWei: '10000000000000000' } as AgentGoal;
const sentinelGoal = { type: 'sentinel', beneficiary: BENE, targetBalanceWei: '50000000000000000', topUpWei: '10000000000000000' } as AgentGoal;
const executorGoal = { type: 'executor' } as AgentGoal;
const traderGoal = { type: 'trader', holdToken: '0x33', spendToken: '0x22', targetHoldWei: '1000000000000000000', clipWei: '100000000000000000' } as AgentGoal;

const snap = (over: Partial<SenseSnapshot> = {}): SenseSnapshot => ({
  beneficiaryBalanceWei: '12000000000000000',
  accountBalanceWei: '500000000000000000',
  remainingWindowWei: '100000000000000000',
  capabilitiesKey: '0:',
  ...over,
});

/** Build a minimal trace record carrying a `detail.cycle`. */
const traceWithCycle = (seq: number, ts: number, cycle: Partial<CycleRecord>): TraceRecord =>
  ({
    agentId: 'a', seq, prevHash: '0x', hash: '0x', ts: new Date(ts * 1000).toISOString(), kind: 'decision',
    detail: { cycle: { action: 'stand_down', amountWei: '0', outcome: 'stood_down', actionPossible: true, observedChange: true, promptTokens: 1000, snapshot: snap(), ...cycle } },
  }) as unknown as TraceRecord;

describe('capabilitiesKey', () => {
  it('is empty-stable and order-independent', () => {
    expect(capabilitiesKey([])).toBe('0:');
    const a = capabilitiesKey([{ selector: '0xAA' }, { selector: '0xbb' }]);
    const b = capabilitiesKey([{ selector: '0xBB' }, { selector: '0xaa' }]);
    expect(a).toBe(b);
    expect(a.startsWith('2:')).toBe(true);
  });
});

describe('snapshotsDiffer', () => {
  it('detects each decision-relevant field move', () => {
    expect(snapshotsDiffer(snap(), snap())).toBe(false);
    expect(snapshotsDiffer(snap({ beneficiaryBalanceWei: '13000000000000000' }), snap())).toBe(true);
    expect(snapshotsDiffer(snap({ accountBalanceWei: '1' }), snap())).toBe(true);
    expect(snapshotsDiffer(snap({ remainingWindowWei: '1' }), snap())).toBe(true);
    expect(snapshotsDiffer(snap({ capabilitiesKey: '1:0xaa' }), snap())).toBe(true);
  });
  it('compares trader fields only when BOTH carry them (role change is a gap, not a diff)', () => {
    expect(snapshotsDiffer(snap({ holdBalanceWei: '5' }), snap())).toBe(false);
    expect(snapshotsDiffer(snap({ holdBalanceWei: '5' }), snap({ holdBalanceWei: '6' }))).toBe(true);
  });
});

describe('computeActionPossible', () => {
  const base = { capabilitiesCount: 0, hasInbound: false, nowSec: now, effectiveBeneficiary: BENE };
  it('treasury: true below target + funded + window + allowlisted', () => {
    expect(computeActionPossible({ ...base, goal: treasuryGoal, policy: pol(), beneficiaryBalanceWei: '12000000000000000', accountBalanceWei: '500000000000000000', holdings: null })).toBe(true);
  });
  it('treasury: false when target already met', () => {
    expect(computeActionPossible({ ...base, goal: treasuryGoal, policy: pol(), beneficiaryBalanceWei: '90000000000000000', accountBalanceWei: '500000000000000000', holdings: null })).toBe(false);
  });
  it('treasury: false when window exhausted / not allowlisted / revoked / expired / unfunded', () => {
    const b = '12000000000000000'; const a = '500000000000000000';
    expect(computeActionPossible({ ...base, goal: treasuryGoal, policy: pol({ remainingWindowWei: '0' }), beneficiaryBalanceWei: b, accountBalanceWei: a, holdings: null })).toBe(false);
    expect(computeActionPossible({ ...base, effectiveBeneficiary: '0xdead', goal: treasuryGoal, policy: pol(), beneficiaryBalanceWei: b, accountBalanceWei: a, holdings: null })).toBe(false);
    expect(computeActionPossible({ ...base, goal: treasuryGoal, policy: pol({ revoked: true }), beneficiaryBalanceWei: b, accountBalanceWei: a, holdings: null })).toBe(false);
    expect(computeActionPossible({ ...base, goal: treasuryGoal, policy: pol({ expiresAt: now - 1 }), beneficiaryBalanceWei: b, accountBalanceWei: a, holdings: null })).toBe(false);
    expect(computeActionPossible({ ...base, goal: treasuryGoal, policy: pol(), beneficiaryBalanceWei: b, accountBalanceWei: '0', holdings: null })).toBe(false);
  });
  it('sentinel: below target regardless of its deliberately-zero caps', () => {
    expect(computeActionPossible({ ...base, goal: sentinelGoal, policy: pol({ perTransferCapWei: '0', windowCapWei: '0', remainingWindowWei: '0' }), beneficiaryBalanceWei: '12000000000000000', accountBalanceWei: '0', holdings: null })).toBe(true);
    expect(computeActionPossible({ ...base, goal: sentinelGoal, policy: pol({ remainingWindowWei: '0' }), beneficiaryBalanceWei: '90000000000000000', accountBalanceWei: '0', holdings: null })).toBe(false);
  });
  it('executor: only with an inbound request + window + funds', () => {
    expect(computeActionPossible({ ...base, goal: executorGoal, policy: pol(), beneficiaryBalanceWei: '0', accountBalanceWei: '500000000000000000', holdings: null, hasInbound: false })).toBe(false);
    expect(computeActionPossible({ ...base, goal: executorGoal, policy: pol(), beneficiaryBalanceWei: '0', accountBalanceWei: '500000000000000000', holdings: null, hasInbound: true })).toBe(true);
  });
  it('trader: needs caps + a clip of spend + below hold target', () => {
    const holdings = { holdBalanceWei: '0', spendBalanceWei: '500000000000000000', routerAllowanceWei: '0' };
    expect(computeActionPossible({ ...base, goal: traderGoal, policy: pol(), beneficiaryBalanceWei: '0', accountBalanceWei: '0', holdings, capabilitiesCount: 2 })).toBe(true);
    expect(computeActionPossible({ ...base, goal: traderGoal, policy: pol(), beneficiaryBalanceWei: '0', accountBalanceWei: '0', holdings, capabilitiesCount: 0 })).toBe(false);
    expect(computeActionPossible({ ...base, goal: traderGoal, policy: pol(), beneficiaryBalanceWei: '0', accountBalanceWei: '0', holdings: { ...holdings, spendBalanceWei: '0' }, capabilitiesCount: 2 })).toBe(false);
    expect(computeActionPossible({ ...base, goal: traderGoal, policy: pol(), beneficiaryBalanceWei: '0', accountBalanceWei: '0', holdings: { ...holdings, holdBalanceWei: '1000000000000000000' }, capabilitiesCount: 2 })).toBe(false);
  });
});

describe('classifyOutcome', () => {
  const PM = 'model output was not a valid decision';
  it('maps runtime outcome types to the carry vocabulary', () => {
    expect(classifyOutcome('acted', undefined, PM)).toBe('landed');
    expect(classifyOutcome('delegated', undefined, PM)).toBe('delegated');
    expect(classifyOutcome('denied', 'owner', PM)).toBe('denied');
    expect(classifyOutcome('failed', 'revert', PM)).toBe('reverted');
    expect(classifyOutcome('stood_down', PM, PM)).toBe('parse_failed');
    expect(classifyOutcome('stood_down', 'spending window exhausted — standing down until it resets', PM)).toBe('blocked');
    expect(classifyOutcome('stood_down', 'boundary active (OverWindowCap)', PM)).toBe('blocked');
    expect(classifyOutcome('stood_down', 'target balance already met', PM)).toBe('stood_down');
  });
});

describe('computeDelta', () => {
  it('is null without a baseline', () => {
    expect(computeDelta(snap(), null)).toBeNull();
  });
  it('is signed current − baseline', () => {
    const d = computeDelta(snap({ beneficiaryBalanceWei: '15000000000000000', remainingWindowWei: '90000000000000000', capabilitiesKey: '1:0xaa' }), snap());
    expect(d).not.toBeNull();
    expect(d!.beneficiaryBalanceWei).toBe('3000000000000000');
    expect(d!.remainingWindowWei).toBe('-10000000000000000');
    expect(d!.capabilitiesChanged).toBe(true);
  });
});

describe('buildCycleMemory', () => {
  it('is null with no traces', () => {
    expect(buildCycleMemory([], now).cycleMemory).toBeNull();
  });
  it('reads the most recent cycle record + surfaces its snapshot for the delta', () => {
    const t = traceWithCycle(5, now - 40, { action: 'send', amountWei: '10000000000000000', outcome: 'landed', snapshot: snap({ beneficiaryBalanceWei: '5' }) });
    const { cycleMemory, baselineSnapshot } = buildCycleMemory([t], now);
    expect(cycleMemory).not.toBeNull();
    expect(cycleMemory!.lastCycle.action).toBe('send');
    expect(cycleMemory!.lastCycle.outcome).toBe('landed');
    expect(cycleMemory!.lastCycle.agoSeconds).toBe(40);
    expect(baselineSnapshot!.beneficiaryBalanceWei).toBe('5');
  });
  it('tallies recentOutcomes across the window', () => {
    const traces = [
      traceWithCycle(9, now - 10, { outcome: 'landed' }),
      traceWithCycle(8, now - 20, { outcome: 'stood_down' }),
      traceWithCycle(7, now - 30, { outcome: 'blocked' }),
      traceWithCycle(6, now - 40, { outcome: 'reverted' }),
      traceWithCycle(5, now - 50, { outcome: 'delegated' }),
    ];
    const r = buildCycleMemory(traces, now).cycleMemory!.recentOutcomes;
    expect(r.sends).toBe(2); // landed + delegated
    expect(r.standDowns).toBe(1);
    expect(r.blocked).toBe(1);
    expect(r.failures).toBe(1); // reverted
  });
  it('falls back to an older snapshot when the head trace carries none (delegate streak)', () => {
    const delegateTrace = { agentId: 'a', seq: 7, prevHash: '0x', hash: '0x', ts: new Date((now - 5) * 1000).toISOString(), kind: 'delegate', detail: { payload: { amountWei: '10000000000000000' } } } as unknown as TraceRecord;
    const olderWithSnap = traceWithCycle(6, now - 60, { snapshot: snap({ accountBalanceWei: '777' }) });
    const { cycleMemory, baselineSnapshot } = buildCycleMemory([delegateTrace, olderWithSnap], now);
    expect(cycleMemory!.lastCycle.outcome).toBe('delegated');
    expect(baselineSnapshot!.accountBalanceWei).toBe('777'); // from the older snapshot-bearing trace
  });
});

describe('renderCycleMemoryDisplay', () => {
  it('renders words and omits delta keys when delta is null', () => {
    const cm = buildCycleMemory([traceWithCycle(1, now - 15, { action: 'send', amountWei: '10000000000000000', outcome: 'landed' })], now).cycleMemory!;
    cm.delta = null;
    const d = renderCycleMemoryDisplay(cm);
    expect(d['lastAction']).toContain('sent');
    expect(d['lastOutcome']).toBe('landed');
    expect(d).not.toHaveProperty('deltaBeneficiary');
  });
  it('renders signed delta words when present', () => {
    const cm = buildCycleMemory([traceWithCycle(1, now - 15, { outcome: 'stood_down' })], now).cycleMemory!;
    cm.delta = { beneficiaryBalanceWei: '-4000000000000000', accountBalanceWei: '0', remainingWindowWei: '0', capabilitiesChanged: false };
    const d = renderCycleMemoryDisplay(cm);
    expect(d['deltaBeneficiary']).toContain('-');
    expect(d['capabilitiesChanged']).toBe('no');
  });
});

describe('deriveCycleFlags (D-1 round 2 — the four scenarios)', () => {
  const mk = (last: CycleMemory['lastCycle'], delta: CycleMemory['delta'], failures = 0): CycleMemory =>
    ({ lastCycle: last, delta, recentOutcomes: { window: 10, sends: 0, standDowns: 0, failures, blocked: 0 } });
  it('repeated-failure → recentFailureStreak', () => {
    const f = deriveCycleFlags(mk({ action: 'send', amountWei: '10000000000000000', outcome: 'reverted', agoSeconds: 30 }, null, 3));
    expect(f.recentFailureStreak).toBe(true);
    expect(f.justToppedUp).toBe(false);
  });
  it('redundant-top-up → justToppedUp (landed recently AND beneficiary rose)', () => {
    const f = deriveCycleFlags(mk({ action: 'send', amountWei: '40000000000000000', outcome: 'landed', agoSeconds: 8 }, { beneficiaryBalanceWei: '40000000000000000', accountBalanceWei: '0', remainingWindowWei: '0', capabilitiesChanged: false }));
    expect(f.justToppedUp).toBe(true);
    expect(f.recentFailureStreak).toBe(false);
  });
  it('drain-detection → NO flags (landed but beneficiary FELL → keep funding)', () => {
    const f = deriveCycleFlags(mk({ action: 'send', amountWei: '10000000000000000', outcome: 'landed', agoSeconds: 40 }, { beneficiaryBalanceWei: '-6000000000000000', accountBalanceWei: '0', remainingWindowWei: '0', capabilitiesChanged: false }));
    expect(f.justToppedUp).toBe(false);
    expect(f.recentFailureStreak).toBe(false);
  });
  it('stale-window → NO flags (a blocked stand-down must not suppress the resume)', () => {
    const f = deriveCycleFlags(mk({ action: 'stand_down', amountWei: '0', outcome: 'blocked', agoSeconds: 130 }, { beneficiaryBalanceWei: '0', accountBalanceWei: '0', remainingWindowWei: '100000000000000000', capabilitiesChanged: false }, 0));
    expect(f.justToppedUp).toBe(false);
    expect(f.recentFailureStreak).toBe(false);
  });
});

describe('prompt integration (D-1 conditional + D-3)', () => {
  const ctx: ReasonContext = { goal: treasuryGoal, beneficiaryBalanceWei: '12000000000000000', accountBalanceWei: '500000000000000000', policy: pol(), nowSec: now };
  const sys = (b: unknown) => ((b as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === 'system')!.content);
  const user = (b: unknown) => ((b as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === 'user')!.content);

  it('cold start is byte-identical to the memoryless baseline (no carry rules, no cycleMemory field)', () => {
    const baseline = buildReasonRequest('m', ctx);
    expect(sys(baseline)).not.toContain('Recent history');
    expect(user(baseline)).not.toContain('cycleMemory');
  });
  it('appends the carry rules + both raw and display carry when cycleMemory is present', () => {
    const cm = buildCycleMemory([traceWithCycle(1, now - 15, { action: 'send', amountWei: '10000000000000000', outcome: 'landed' })], now).cycleMemory!;
    cm.delta = { beneficiaryBalanceWei: '-4000000000000000', accountBalanceWei: '0', remainingWindowWei: '0', capabilitiesChanged: false };
    const withMem = buildReasonRequest('m', { ...ctx, cycleMemory: cm });
    expect(sys(withMem)).toContain('Recent history');
    const obs = JSON.parse(user(withMem).replace(/^Observation:\n/, '')) as Record<string, unknown>;
    expect(obs['cycleMemory']).toBeTruthy();
    expect((obs['display'] as Record<string, unknown>)['cycleMemory']).toBeTruthy();
  });
  it('round-2 flags: appends the minimal flags clause + observation.cycleFlags (no prose block)', () => {
    const b = buildReasonRequest('m', { ...ctx, cycleFlags: { recentFailureStreak: true, justToppedUp: false } });
    expect(sys(b)).toContain('cycleFlags');
    expect(sys(b)).not.toContain('Recent history'); // not the prose carry
    const obs = JSON.parse(user(b).replace(/^Observation:\n/, '')) as Record<string, unknown>;
    expect(obs['cycleFlags']).toEqual({ recentFailureStreak: true, justToppedUp: false });
  });
  it('D-3: caps the shown allowlist to 10 with a +N more marker, never the on-chain set', () => {
    const many = Array.from({ length: 15 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    const b = buildReasonRequest('m', { ...ctx, policy: pol({ allowlist: many }) });
    const obs = JSON.parse(user(b).replace(/^Observation:\n/, '')) as { policy: { allowlist: string[]; allowlistTruncated?: string } };
    expect(obs.policy.allowlist).toHaveLength(10);
    expect(obs.policy.allowlistTruncated).toBe('+5 more');
  });
});
