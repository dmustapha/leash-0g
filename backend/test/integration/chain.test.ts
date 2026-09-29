import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import { createLink } from '../../src/coordination/store.js';
import { insertDirectionDraft } from '../../src/store/directions.js';
import { getChain, insertPlannedChain } from '../../src/store/chains.js';
import { listDelegations } from '../../src/coordination/store.js';
import {
  DEFAULT_CHAIN_CONFIG,
  proposeNextHop,
  selectHopTargetViaGateway,
  validateChainPlan,
  type ChainDeps,
} from '../../src/coordination/chain.js';
import { vi } from 'vitest';
import type { AgentRow, ChainStep } from '../../src/types.js';
import type { DirectionDraft } from '../../src/direction/direction.js';

/**
 * Phase 5.6 security spine (spec §7.A + D-1/D-2/D-4 + BC-2). Owner-only origin
 * with Option-C caged selection, single-owner scope, bounded/acyclic topology,
 * and the load-bearing BC-2 enforcement point (runtime selection re-validated
 * SERVER-SIDE ∈ eligibleTargetIds; off-set → hard reject, chain never advances).
 */

let db: TestDb;
let t: TestApp;

const OWNER = '0x' + '7c'.repeat(20);
const OTHER = '0x' + '8d'.repeat(20);

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => {
  t = buildTestApp(db.pool);
});

let seq = 0;
async function seed(owner = OWNER, goal: Record<string, unknown> = {}): Promise<AgentRow> {
  seq += 1;
  const suffix = seq.toString(16).padStart(4, '0');
  const id = await seedAgent(db.pool, {
    ownerAddr: owner,
    name: `chain-agent-${seq}`,
    accountAddr: `0x${'ac'.repeat(18)}${suffix}`,
    sessionKeyAddr: `0x${'5e'.repeat(18)}${suffix}`,
    goal,
  });
  const a = await getAgentById(db.pool, id);
  if (!a) throw new Error('seed failed');
  return a;
}

const EXECUTOR = { type: 'executor' }; // spender
const SENTINEL = { type: 'sentinel', beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1' }; // spend-incapable

async function draftFor(agent: AgentRow): Promise<string> {
  const draft: DirectionDraft = {
    agentId: agent.id,
    currentRole: 'treasury',
    understanding: 'analyze then hand off',
    goalPatch: {},
    moneyPower: 'can-move-money',
    unsureFields: [],
    confidence: 'high',
  };
  const row = await insertDirectionDraft(db.pool, { agentId: agent.id, ownerAddr: OWNER, intent: 'x', draft });
  return row.id;
}

function chainDeps(): ChainDeps {
  return { pool: db.pool, hub: t.hub, coordinator: t.coordinator, config: DEFAULT_CHAIN_CONFIG };
}

describe('validateChainPlan (D-1/D-4/D-8)', () => {
  it('accepts a valid 2-hop plan over existing links', async () => {
    const origin = await seed();
    const mid = await seed(OWNER, SENTINEL);
    const end = await seed(OWNER, EXECUTOR);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: mid.id, mode: 'auto' });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: mid.id, toAgentId: end.id, mode: 'supervised' });
    const plan: ChainStep[] = [
      { eligibleTargetIds: [mid.id], directedIntent: 'analyze' },
      { eligibleTargetIds: [end.id], directedIntent: 'execute' },
    ];
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r.ok).toBe(true);
  });

  it('rejects a cross-owner target → invalid_chain', async () => {
    const origin = await seed();
    const foreign = await seed(OTHER, EXECUTOR);
    const plan = [{ eligibleTargetIds: [foreign.id], directedIntent: 'x' }];
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r).toMatchObject({ ok: false, error: 'invalid_chain' });
  });

  it('rejects an unlinked (but owned) target → invalid_chain', async () => {
    const origin = await seed();
    const owned = await seed(OWNER, EXECUTOR); // owned but NO link
    const plan = [{ eligibleTargetIds: [owned.id], directedIntent: 'x' }];
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r).toMatchObject({ ok: false, error: 'invalid_chain' });
  });

  it('rejects origin in an eligible set → chain_cycle', async () => {
    const origin = await seed();
    const plan = [{ eligibleTargetIds: [origin.id], directedIntent: 'x' }];
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r).toMatchObject({ ok: false, error: 'chain_cycle' });
  });

  it('rejects a fixed plan that revisits an agent → chain_cycle', async () => {
    const origin = await seed();
    const mid = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: mid.id, mode: 'auto' });
    // A fixed (all one-member) plan origin→mid→mid revisits `mid` — the cycle
    // check fires before reachability (no self-link needed; the DB forbids one).
    const plan = [
      { eligibleTargetIds: [mid.id], directedIntent: 'a' },
      { eligibleTargetIds: [mid.id], directedIntent: 'b' },
    ];
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r).toMatchObject({ ok: false, error: 'chain_cycle' });
  });

  it('rejects depth-cap+1', async () => {
    const origin = await seed();
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    const plan = Array.from({ length: DEFAULT_CHAIN_CONFIG.maxDepth + 1 }, () => ({
      eligibleTargetIds: [a.id],
      directedIntent: 'x',
    }));
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r).toMatchObject({ ok: false, error: 'invalid_chain' });
  });

  it('rejects eligible-set-cap+1', async () => {
    const origin = await seed();
    const targets = [];
    for (let i = 0; i <= DEFAULT_CHAIN_CONFIG.maxEligiblePerHop; i++) {
      const a = await seed(OWNER, SENTINEL);
      await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
      targets.push(a.id);
    }
    const plan = [{ eligibleTargetIds: targets, directedIntent: 'x' }];
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r).toMatchObject({ ok: false, error: 'invalid_chain' });
  });

  it('rejects an empty plan / empty eligible set / blank intent', async () => {
    const origin = await seed();
    expect((await validateChainPlan(db.pool, OWNER, origin.id, [])).ok).toBe(false);
    expect((await validateChainPlan(db.pool, OWNER, origin.id, [{ eligibleTargetIds: [], directedIntent: 'x' }])).ok).toBe(false);
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    expect((await validateChainPlan(db.pool, OWNER, origin.id, [{ eligibleTargetIds: [a.id], directedIntent: '  ' }])).ok).toBe(false);
  });
});

describe('proposeNextHop — BC-2 + idempotent CAS + Gap-2 (D-2)', () => {
  async function setupOneHop(targetGoal: Record<string, unknown>, mode: 'auto' | 'supervised' = 'auto') {
    const origin = await seed();
    const target = await seed(OWNER, targetGoal);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: target.id, mode });
    const directionId = await draftFor(origin);
    const chain = await insertPlannedChain(db.pool, {
      ownerAddr: OWNER,
      originAgentId: origin.id,
      directionId,
      plan: [{ eligibleTargetIds: [target.id], directedIntent: 'do the thing' }],
    });
    return { origin, target, chain };
  }

  it('BC-2: an emitted target OUTSIDE the eligible set is a HARD reject — chain terminates, no delegation', async () => {
    const { chain, origin } = await setupOneHop(EXECUTOR);
    const off = (await seed(OWNER, EXECUTOR)).id; // owned but NOT in the eligible set
    const out = await proposeNextHop(chainDeps(), chain.id, { note: 'x' }, { emitted: off });
    expect(out).toMatchObject({ kind: 'terminated', reason: 'selection_off_set' });
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated');
    const { delegations } = await listDelegations(db.pool, { agentId: origin.id });
    expect(delegations).toHaveLength(0); // never advanced off-list
  });

  it('BC-2: a malformed emitted selection is a HARD reject', async () => {
    const { chain } = await setupOneHop(EXECUTOR);
    const out = await proposeNextHop(chainDeps(), chain.id, null, { emitted: 'not-a-uuid' });
    expect(out).toMatchObject({ kind: 'terminated', reason: 'selection_off_set' });
  });

  it('auto selection advances: issues a chain.handoff over the plan link', async () => {
    const { chain, target } = await setupOneHop(SENTINEL); // spend-incapable target
    const out = await proposeNextHop(chainDeps(), chain.id, { finding: 'buy' }, { auto: true });
    expect(out.kind).toBe('advanced');
    if (out.kind !== 'advanced') return;
    expect(out.selectedTargetId).toBe(target.id);
    const { delegations } = await listDelegations(db.pool, { agentId: target.id });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]!.kind).toBe('chain.handoff');
    const after = await getChain(db.pool, chain.id);
    expect(after?.nextHop).toBe(1);
    expect(after?.currentDelegationId).toBe(out.delegationId);
    expect(after?.path).toEqual([chain.originAgentId, target.id]);
  });

  it('Gap-2/D-2: a SPENDER target is forced supervised (pending_approval) even on an auto link', async () => {
    const { chain } = await setupOneHop(EXECUTOR, 'auto'); // spender + auto link
    const out = await proposeNextHop(chainDeps(), chain.id, null, { auto: true });
    expect(out.kind).toBe('advanced');
    if (out.kind !== 'advanced') return;
    expect(out.supervised).toBe(true);
    const { delegations } = await listDelegations(db.pool, {});
    const hop = delegations.find((d) => d.id === out.delegationId);
    expect(hop?.status).toBe('pending_approval');
  });

  it('spend-incapable target on an auto link flows without approval (pending)', async () => {
    const { chain } = await setupOneHop(SENTINEL, 'auto');
    const out = await proposeNextHop(chainDeps(), chain.id, null, { auto: true });
    expect(out.kind).toBe('advanced');
    if (out.kind !== 'advanced') return;
    expect(out.supervised).toBe(false);
  });

  it('idempotent: a second propose for the same hop is a no-op (no second delegation)', async () => {
    const { chain, target } = await setupOneHop(SENTINEL);
    const first = await proposeNextHop(chainDeps(), chain.id, null, { auto: true });
    expect(first.kind).toBe('advanced');
    const second = await proposeNextHop(chainDeps(), chain.id, null, { auto: true });
    expect(second.kind).toBe('noop');
    const { delegations } = await listDelegations(db.pool, { agentId: target.id });
    expect(delegations).toHaveLength(1);
  });

  it('concurrent proposes race to exactly one delegation (CAS)', async () => {
    const { chain, target } = await setupOneHop(SENTINEL);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => proposeNextHop(chainDeps(), chain.id, null, { auto: true })),
    );
    expect(results.filter((r) => r.kind === 'advanced')).toHaveLength(1);
    const { delegations } = await listDelegations(db.pool, { agentId: target.id });
    expect(delegations).toHaveLength(1);
  });
});

describe('Option-C model-driven selection (S25) + BC-2', () => {
  function gatewayReturning(targetId: unknown): typeof fetch {
    return async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ targetId }) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }

  it('a one-member hop never calls the model (deterministic fixed hop)', async () => {
    const spy = vi.fn();
    const only = await selectHopTargetViaGateway(
      { gatewayUrl: 'http://gw', gatewayToken: 't', model: 'm', fetchFn: spy },
      { eligibleTargetIds: ['only-id'], directedIntent: 'x', upstreamOutput: null },
    );
    expect(only).toBe('only-id');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a multi-member hop returns the model-emitted id (untrusted; BC-2 re-validates at propose)', async () => {
    const picked = await selectHopTargetViaGateway(
      { gatewayUrl: 'http://gw', gatewayToken: 't', model: 'm', fetchFn: gatewayReturning('b') },
      { eligibleTargetIds: ['a', 'b'], directedIntent: 'pick b', upstreamOutput: { hint: 'b' } },
    );
    expect(picked).toBe('b');
  });

  it('a garbled / non-JSON gateway reply → undefined (caller falls back to auto)', async () => {
    const bad = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const r = await selectHopTargetViaGateway(
      { gatewayUrl: 'http://gw', gatewayToken: 't', model: 'm', fetchFn: bad },
      { eligibleTargetIds: ['a', 'b'], directedIntent: 'x', upstreamOutput: null },
    );
    expect(r).toBeUndefined();
  });

  it('a model-emitted IN-SET target advances to THAT target (dynamic, caged) — even the non-default one', async () => {
    const origin = await seed();
    const a = await seed(OWNER, SENTINEL);
    const b = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: b.id, mode: 'auto' });
    const directionId = await draftFor(origin);
    const chain = await insertPlannedChain(db.pool, {
      ownerAddr: OWNER,
      originAgentId: origin.id,
      directionId,
      plan: [{ eligibleTargetIds: [a.id, b.id], directedIntent: 'route it' }],
    });
    // Model picks `b` (the non-default; deterministic auto would pick `a` first).
    const out = await proposeNextHop(chainDeps(), chain.id, { x: 1 }, { emitted: b.id });
    expect(out.kind).toBe('advanced');
    if (out.kind !== 'advanced') return;
    expect(out.selectedTargetId).toBe(b.id);
    const { delegations } = await listDelegations(db.pool, { agentId: b.id });
    expect(delegations).toHaveLength(1);
    const { delegations: aDelegs } = await listDelegations(db.pool, { agentId: a.id });
    expect(aDelegs).toHaveLength(0); // the caged pick reached b, not the default a
  });
});
