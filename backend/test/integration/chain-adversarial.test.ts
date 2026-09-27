import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import { createLink, listDelegations } from '../../src/coordination/store.js';
import { insertDirectionDraft } from '../../src/store/directions.js';
import { getChain, insertPlannedChain } from '../../src/store/chains.js';
import { DEFAULT_CHAIN_CONFIG, proposeNextHop, validateChainPlan, type ChainDeps } from '../../src/coordination/chain.js';
import type { AgentRow, ChainStep } from '../../src/types.js';
import type { DirectionDraft } from '../../src/direction/direction.js';

/**
 * D-12 (BINDING) — Phase 5.6 adversarial + stress hardening. Three red-team
 * classes applied to the NEW chaining surface + a fuzz/boundary suite. The
 * money/authority spine must hold CLOSED on every vector; every spine finding is
 * fixed in-phase (this file is the evidence). See PHASE-5.6-RESULTS.md.
 *
 * RED-TEAM 1 — injection / self-origination
 * RED-TEAM 2 — races / data-integrity
 * RED-TEAM 3 — authz / DoS / quarantine
 * FUZZ       — prototype-pollution · unicode/bidi/control · type-smuggling · boundaries
 */

let db: TestDb;
let t: TestApp;
const OWNER = '0x' + 'd5'.repeat(20);
const OTHER = '0x' + 'e6'.repeat(20);

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
async function seed(owner: string, goal: Record<string, unknown> = {}): Promise<AgentRow> {
  seq += 1;
  const suffix = seq.toString(16).padStart(4, '0');
  const id = await seedAgent(db.pool, {
    ownerAddr: owner,
    name: `adv-${seq}`,
    accountAddr: `0x${'ac'.repeat(18)}${suffix}`,
    sessionKeyAddr: `0x${'5e'.repeat(18)}${suffix}`,
    goal,
  });
  const a = await getAgentById(db.pool, id);
  if (!a) throw new Error('seed failed');
  return a;
}
const SENTINEL = { type: 'sentinel', beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1' };
function deps(): ChainDeps {
  return { pool: db.pool, hub: t.hub, coordinator: t.coordinator, config: DEFAULT_CHAIN_CONFIG };
}
async function draftFor(agentId: string): Promise<string> {
  const draft: DirectionDraft = {
    agentId,
    currentRole: 'treasury',
    understanding: 'x',
    goalPatch: {},
    moneyPower: 'can-move-money',
    unsureFields: [],
    confidence: 'high',
  };
  const row = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'x', draft });
  return row.id;
}
async function oneHopChain(targetGoal: Record<string, unknown> = SENTINEL) {
  const origin = await seed(OWNER);
  const target = await seed(OWNER, targetGoal);
  await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: target.id, mode: 'auto' });
  const directionId = await draftFor(origin.id);
  const chain = await insertPlannedChain(db.pool, {
    ownerAddr: OWNER,
    originAgentId: origin.id,
    directionId,
    plan: [{ eligibleTargetIds: [target.id], directedIntent: 'do' }],
  });
  return { origin, target, chain };
}

describe('RED-TEAM 1 — injection / self-origination', () => {
  it('a hijacked upstream cannot select an owned+linked target that is OFF the hop set', async () => {
    const { origin, chain } = await oneHopChain();
    // An off-set target that IS owned AND linked from origin — still rejected.
    const rogue = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: rogue.id, mode: 'auto' });
    const out = await proposeNextHop(deps(), chain.id, null, { emitted: rogue.id });
    expect(out).toMatchObject({ kind: 'terminated', reason: 'selection_off_set' });
    const { delegations } = await listDelegations(db.pool, { agentId: rogue.id });
    expect(delegations).toHaveLength(0);
  });

  it('a poisoned/oversized upstreamOutput cannot be placed — the hop fails, chain terminates', async () => {
    const { chain, target } = await oneHopChain();
    const huge = { blob: 'A'.repeat(20_000) }; // > delegationPayloadMaxBytes (16KB)
    const out = await proposeNextHop(deps(), chain.id, huge, { auto: true });
    expect(out.kind).toBe('terminated');
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated');
    const { delegations } = await listDelegations(db.pool, { agentId: target.id });
    expect(delegations).toHaveLength(0);
  });

  it('a hop can never originate without an owner-confirmed plan (proposeNextHop reads the projection only)', async () => {
    // No chain row at all → proposeNextHop is a no-op (cannot invent a hop).
    const out = await proposeNextHop(deps(), '00000000-0000-0000-0000-000000000000', null, { auto: true });
    expect(out).toMatchObject({ kind: 'noop' });
  });
});

describe('RED-TEAM 2 — races / data-integrity', () => {
  it('propose after the chain is terminated is a no-op', async () => {
    const { chain } = await oneHopChain();
    await proposeNextHop(deps(), chain.id, null, { emitted: 'not-a-uuid' }); // terminates
    const out = await proposeNextHop(deps(), chain.id, null, { auto: true });
    expect(out).toMatchObject({ kind: 'noop' });
  });

  it('N-way concurrent propose → exactly one delegation (CAS)', async () => {
    const { chain, target } = await oneHopChain();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => proposeNextHop(deps(), chain.id, null, { auto: true })),
    );
    expect(results.filter((r) => r.kind === 'advanced')).toHaveLength(1);
    const { delegations } = await listDelegations(db.pool, { agentId: target.id });
    expect(delegations).toHaveLength(1);
  });

  it('propose after revoke fan-out cancels the in-flight hop cannot double-advance', async () => {
    const { chain } = await oneHopChain();
    const first = await proposeNextHop(deps(), chain.id, null, { auto: true });
    expect(first.kind).toBe('advanced');
    // A second propose while a hop is in flight is a no-op (current_delegation_id set).
    const second = await proposeNextHop(deps(), chain.id, null, { auto: true });
    expect(second).toMatchObject({ kind: 'noop' });
  });
});

describe('RED-TEAM 3 — authz / DoS / quarantine', () => {
  it('cross-owner target in a plan is rejected (single-owner scope, D-8)', async () => {
    const origin = await seed(OWNER);
    const foreign = await seed(OTHER, SENTINEL);
    const r = await validateChainPlan(db.pool, OWNER, origin.id, [
      { eligibleTargetIds: [foreign.id], directedIntent: 'x' },
    ]);
    expect(r).toMatchObject({ ok: false, error: 'invalid_chain' });
  });

  it('the per-link throttle still bounds chain-hop issuance', async () => {
    // Fill the link's pending ceiling with non-chain delegations, then a chain
    // hop over the same link is throttled → the hop fails, chain terminates.
    const origin = await seed(OWNER);
    const target = await seed(OWNER, SENTINEL);
    const link = await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: target.id, mode: 'auto' });
    // testSettings: delegationMaxPendingPerLink = 3 — saturate it.
    for (let i = 0; i < 3; i++) {
      await t.coordinator.issueDelegation({ fromAgent: origin, kind: 'noise', payload: { i }, toAgentId: target.id });
    }
    const directionId = await draftFor(origin.id);
    const chain = await insertPlannedChain(db.pool, {
      ownerAddr: OWNER,
      originAgentId: origin.id,
      directionId,
      plan: [{ eligibleTargetIds: [target.id], directedIntent: 'do' }],
    });
    const out = await proposeNextHop(deps(), chain.id, null, { auto: true });
    expect(out.kind).toBe('terminated'); // throttled → hop could not be placed
    void link;
  });
});

describe('FUZZ — prototype-pollution · type-smuggling · unicode · boundaries', () => {
  it('a __proto__-laden plan does not pollute Object.prototype and is rejected', async () => {
    const origin = await seed(OWNER);
    const malicious = JSON.parse('[{"eligibleTargetIds":["x"],"directedIntent":"i","__proto__":{"polluted":true}}]');
    const r = await validateChainPlan(db.pool, OWNER, origin.id, malicious);
    expect(r.ok).toBe(false); // 'x' is not a uuid
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('type-smuggled eligibleTargetIds (numbers / objects / nested) are rejected', async () => {
    const origin = await seed(OWNER);
    for (const bad of [[1, 2], [{}], [['nested']], [null], [true]]) {
      const r = await validateChainPlan(db.pool, OWNER, origin.id, [{ eligibleTargetIds: bad, directedIntent: 'i' }]);
      expect(r.ok).toBe(false);
    }
  });

  it('type-smuggled directedIntent (non-string / object / array) is rejected', async () => {
    const origin = await seed(OWNER);
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    for (const bad of [123, {}, [], null, true]) {
      const r = await validateChainPlan(db.pool, OWNER, origin.id, [
        { eligibleTargetIds: [a.id], directedIntent: bad as unknown as string },
      ]);
      expect(r.ok).toBe(false);
    }
  });

  it('an oversized directedIntent (> 2000 chars) is rejected', async () => {
    const origin = await seed(OWNER);
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    const r = await validateChainPlan(db.pool, OWNER, origin.id, [
      { eligibleTargetIds: [a.id], directedIntent: 'x'.repeat(2001) },
    ]);
    expect(r.ok).toBe(false);
  });

  it('bidi/zero-width chars in directedIntent are accepted as DATA (quarantined, never authority)', async () => {
    const origin = await seed(OWNER);
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    const bidi = 'buy\u202Eevil\u200B now'; // RTL override + zero-width space (NOT C0 controls)
    const plan: ChainStep[] = [{ eligibleTargetIds: [a.id], directedIntent: bidi }];
    const r = await validateChainPlan(db.pool, OWNER, origin.id, plan);
    expect(r.ok).toBe(true); // descriptive text — the FE renders it quarantined, never innerHTML/parse_mode
    const directionId = await draftFor(origin.id);
    const chain = await insertPlannedChain(db.pool, { ownerAddr: OWNER, originAgentId: origin.id, directionId, plan });
    const got = await getChain(db.pool, chain.id);
    expect(got?.plan[0]!.directedIntent).toContain('now');
  });

  it('D-12 fix: a NUL / C0 control char in directedIntent is REJECTED (jsonb-safe + injection guard)', async () => {
    const origin = await seed(OWNER);
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    for (const bad of ['buy\u0000now', 'x\u0007y', 'a\u001Bb', 'c\u007Fd']) {
      const rr = await validateChainPlan(db.pool, OWNER, origin.id, [{ eligibleTargetIds: [a.id], directedIntent: bad }]);
      expect(rr).toMatchObject({ ok: false, error: 'invalid_chain' });
    }
  });
  it('boundary: depth 0 (empty) rejected; depth == cap accepted; cap+1 rejected', async () => {
    const origin = await seed(OWNER);
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    const b = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: a.id, toAgentId: b.id, mode: 'auto' });
    const c = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: b.id, toAgentId: c.id, mode: 'auto' });
    expect((await validateChainPlan(db.pool, OWNER, origin.id, [])).ok).toBe(false);
    // depth == cap (3): origin→a→b→c
    const atCap: ChainStep[] = [
      { eligibleTargetIds: [a.id], directedIntent: 'i' },
      { eligibleTargetIds: [b.id], directedIntent: 'i' },
      { eligibleTargetIds: [c.id], directedIntent: 'i' },
    ];
    expect((await validateChainPlan(db.pool, OWNER, origin.id, atCap)).ok).toBe(true);
    // cap+1
    const d = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: c.id, toAgentId: d.id, mode: 'auto' });
    expect((await validateChainPlan(db.pool, OWNER, origin.id, [...atCap, { eligibleTargetIds: [d.id], directedIntent: 'i' }])).ok).toBe(false);
  });
});

describe('FUZZ 2 — more validation edges', () => {
  it('eligible-set EXACTLY at cap is accepted; a step that is an array/primitive is rejected', async () => {
    const origin = await seed(OWNER);
    const ids: string[] = [];
    for (let i = 0; i < DEFAULT_CHAIN_CONFIG.maxEligiblePerHop; i++) {
      const a = await seed(OWNER, SENTINEL);
      await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
      ids.push(a.id);
    }
    expect((await validateChainPlan(db.pool, OWNER, origin.id, [{ eligibleTargetIds: ids, directedIntent: 'ok' }])).ok).toBe(true);
    for (const badStep of [['not-an-object'], [42], ['x'], [null]]) {
      expect((await validateChainPlan(db.pool, OWNER, origin.id, badStep)).ok).toBe(false);
    }
  });

  it('a multi-hop FIXED plan that revisits an earlier target → chain_cycle', async () => {
    const origin = await seed(OWNER);
    const a = await seed(OWNER, SENTINEL);
    const b = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: a.id, toAgentId: b.id, mode: 'auto' });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: b.id, toAgentId: a.id, mode: 'auto' });
    // origin → a → b → a  (revisits a)
    const plan = [
      { eligibleTargetIds: [a.id], directedIntent: '1' },
      { eligibleTargetIds: [b.id], directedIntent: '2' },
      { eligibleTargetIds: [a.id], directedIntent: '3' },
    ];
    expect(await validateChainPlan(db.pool, OWNER, origin.id, plan)).toMatchObject({ ok: false, error: 'chain_cycle' });
  });

  it('an upstreamOutput JUST UNDER the payload cap advances (boundary)', async () => {
    const { chain, target } = await oneHopChain();
    // ~8KB — comfortably under the 16KB delegationPayloadMaxBytes with envelope overhead.
    const out = await proposeNextHop(deps(), chain.id, { blob: 'a'.repeat(8000) }, { auto: true });
    expect(out.kind).toBe('advanced');
    const { delegations } = await listDelegations(db.pool, { agentId: target.id });
    expect(delegations).toHaveLength(1);
  });

  it('a hop that names the origin as a target is rejected at confirm-time validation (chain_cycle)', async () => {
    const origin = await seed(OWNER);
    const a = await seed(OWNER, SENTINEL);
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: a.id, mode: 'auto' });
    const plan = [
      { eligibleTargetIds: [a.id], directedIntent: '1' },
      { eligibleTargetIds: [origin.id], directedIntent: 'loop back' },
    ];
    expect(await validateChainPlan(db.pool, OWNER, origin.id, plan)).toMatchObject({ ok: false, error: 'chain_cycle' });
  });
});
