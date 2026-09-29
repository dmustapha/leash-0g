import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, testSettings, type TestApp } from '../helpers/app.js';
import { getAgentById } from '../../src/store/agents.js';
import { createLink, listDelegations } from '../../src/coordination/store.js';
import { DelegationCoordinator } from '../../src/coordination/coordinator.js';
import { insertDirectionDraft } from '../../src/store/directions.js';
import {
  getChain,
  insertPlannedChain,
  listAdvancingChainsForOrigin,
  settleChainHop,
  terminateChain,
} from '../../src/store/chains.js';
import {
  DEFAULT_CHAIN_CONFIG,
  onHopSettled,
  proposeNextHop,
  terminateOriginChainsForWindDown,
  type ChainDeps,
} from '../../src/coordination/chain.js';
import type { AgentRow, ChainStep } from '../../src/types.js';
import type { DirectionDraft } from '../../src/direction/direction.js';

/**
 * Phase 5.6 orchestration (spec §3b): the coordinator's generic terminal-
 * delegation callback drives onHopSettled — a COMPLETED hop advances the chain
 * + proposes the next hop (carrying the downstream's output); a terminal-BAD
 * hop terminates the chain. Idempotent + keyed on the projection.
 */

let db: TestDb;
let t: TestApp;
const OWNER = '0x' + '9e'.repeat(20);

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
async function seed(goal: Record<string, unknown>): Promise<AgentRow> {
  seq += 1;
  const suffix = seq.toString(16).padStart(4, '0');
  const id = await seedAgent(db.pool, {
    ownerAddr: OWNER,
    name: `orch-${seq}`,
    accountAddr: `0x${'ac'.repeat(18)}${suffix}`,
    sessionKeyAddr: `0x${'5e'.repeat(18)}${suffix}`,
    goal,
  });
  const a = await getAgentById(db.pool, id);
  if (!a) throw new Error('seed failed');
  return a;
}
const SENTINEL = { type: 'sentinel', beneficiary: '0x' + '11'.repeat(20), targetBalanceWei: '1' };

async function draftFor(agentId: string): Promise<string> {
  const draft: DirectionDraft = {
    agentId,
    currentRole: 'treasury',
    understanding: 'x',
    goalPatch: {},
    moneyPower: 'cannot-move-money',
    unsureFields: [],
    confidence: 'high',
  };
  const row = await insertDirectionDraft(db.pool, { agentId, ownerAddr: OWNER, intent: 'x', draft });
  return row.id;
}

/** A coordinator whose terminal callback drives onHopSettled (composition-root shape). */
function wiredCoordinator(): { coordinator: DelegationCoordinator; deps: () => ChainDeps } {
  // eslint-disable-next-line prefer-const -- forward-referenced by the `deps` closure below, so it must be declared before assignment (const impossible here)
  let coordinator!: DelegationCoordinator;
  const deps = (): ChainDeps => ({ pool: db.pool, hub: t.hub, coordinator, config: DEFAULT_CHAIN_CONFIG });
  coordinator = new DelegationCoordinator({
    pool: db.pool,
    hub: t.hub,
    runtime: { nudge: () => undefined },
    settings: testSettings(),
    onDelegationTerminal: async (d) => {
      const output = ((d.result as { output?: unknown } | undefined)?.output ?? d.result ?? null) as never;
      const p = (d.payload ?? {}) as { chainId?: unknown; hopIndex?: unknown };
      await onHopSettled(deps(), d.id, { status: d.status, output, hint: { chainId: p.chainId, hopIndex: p.hopIndex } });
    },
  });
  return { coordinator, deps };
}

async function build2HopChain() {
  const origin = await seed({});
  const mid = await seed(SENTINEL);
  const end = await seed(SENTINEL);
  await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: mid.id, mode: 'auto' });
  await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: mid.id, toAgentId: end.id, mode: 'auto' });
  const directionId = await draftFor(origin.id);
  const plan: ChainStep[] = [
    { eligibleTargetIds: [mid.id], directedIntent: 'analyze' },
    { eligibleTargetIds: [end.id], directedIntent: 'summarize' },
  ];
  const chain = await insertPlannedChain(db.pool, { ownerAddr: OWNER, originAgentId: origin.id, directionId, plan });
  return { origin, mid, end, chain };
}

describe('onHopSettled — advance / complete / terminate', () => {
  it('a completed hop advances to the next hop carrying the downstream output', async () => {
    const { chain, mid, end } = await build2HopChain();
    const { coordinator, deps } = wiredCoordinator();
    // Propose hop 0 → delegation to mid (auto, spend-incapable → pending).
    const h0 = await proposeNextHop(deps(), chain.id, { seed: true }, { auto: true });
    expect(h0.kind).toBe('advanced');
    if (h0.kind !== 'advanced') return;
    // Simulate mid picking it up + completing with its own output.
    await coordinator.markAccepted(h0.delegationId);
    await coordinator.markCompleted(h0.delegationId, { output: { finding: 'buy 5' } });
    // The terminal callback advanced the chain → hop 1 proposed to `end`.
    const after = await getChain(db.pool, chain.id);
    expect(after?.nextHop).toBe(2);
    expect(after?.path).toEqual([chain.originAgentId, mid.id, end.id]);
    const { delegations } = await listDelegations(db.pool, { agentId: end.id });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]!.kind).toBe('chain.handoff');
    // The next hop's payload carried the downstream's output as upstreamOutput.
    const payload = delegations[0]!.payload as { upstreamOutput?: { finding?: string } };
    expect(payload.upstreamOutput?.finding).toBe('buy 5');
  });

  it('completing the LAST hop completes the chain', async () => {
    const { chain } = await build2HopChain();
    const { coordinator, deps } = wiredCoordinator();
    const h0 = await proposeNextHop(deps(), chain.id, null, { auto: true });
    if (h0.kind !== 'advanced') throw new Error('hop0 not advanced');
    await coordinator.markAccepted(h0.delegationId);
    await coordinator.markCompleted(h0.delegationId, { output: {} });
    const mid = await getChain(db.pool, chain.id);
    const h1Deleg = mid?.currentDelegationId;
    expect(h1Deleg).toBeTruthy();
    await coordinator.markAccepted(h1Deleg!);
    await coordinator.markCompleted(h1Deleg!, { output: {} });
    const done = await getChain(db.pool, chain.id);
    expect(done?.status).toBe('completed');
  });

  it('a failed hop terminates the chain (no next hop)', async () => {
    const { chain, end } = await build2HopChain();
    const { coordinator, deps } = wiredCoordinator();
    const h0 = await proposeNextHop(deps(), chain.id, null, { auto: true });
    if (h0.kind !== 'advanced') throw new Error('hop0 not advanced');
    await coordinator.markAccepted(h0.delegationId);
    await coordinator.markFailed(h0.delegationId, 'downstream error');
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated');
    const { delegations } = await listDelegations(db.pool, { agentId: end.id });
    expect(delegations).toHaveLength(0); // never advanced
  });

  it('W2: a hop ISSUED but never bound (crash in the issue→bind window) still reconciles on settle', async () => {
    const { chain, mid, end } = await build2HopChain();
    const { coordinator, deps } = wiredCoordinator();
    const h0 = await proposeNextHop(deps(), chain.id, { seed: true }, { auto: true });
    if (h0.kind !== 'advanced') throw new Error('hop0 not advanced');
    // Simulate the crash BEFORE setChainCurrentDelegation persisted: the chain
    // has advanced next_hop but has NO bound in-flight delegation.
    await db.pool.query(`UPDATE chains SET current_delegation_id = NULL WHERE id = $1`, [chain.id]);
    // The issued hop delegation now settles — getChainByCurrentDelegation misses,
    // so onHopSettled must reconcile via the payload hint (chainId/hopIndex).
    await coordinator.markAccepted(h0.delegationId);
    await coordinator.markCompleted(h0.delegationId, { output: { finding: 'x' } });
    const after = await getChain(db.pool, chain.id);
    expect(after?.nextHop).toBe(2);
    expect(after?.path).toEqual([chain.originAgentId, mid.id, end.id]);
    const { delegations } = await listDelegations(db.pool, { agentId: end.id });
    expect(delegations).toHaveLength(1); // the next hop was proposed despite the stranding
  });

  it('W2 reconciliation NEVER touches an unrelated / already-advanced chain', async () => {
    // A settled delegation whose hint points at a chain that is NOT waiting on
    // exactly that un-bound hop must be a no-op.
    const { chain } = await build2HopChain();
    const { deps } = wiredCoordinator();
    // chain is 'planned' (nextHop 0). A hint claiming hopIndex 5 (nextHop would
    // need to be 6) must not advance/terminate it.
    await onHopSettled(deps(), '00000000-0000-0000-0000-0000000000ff', {
      status: 'completed',
      hint: { chainId: chain.id, hopIndex: 5 },
    });
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('planned');
    expect(after?.nextHop).toBe(0);
  });

  it('double-settle is idempotent — a hop cannot advance the chain twice', async () => {
    const { chain, end } = await build2HopChain();
    const { coordinator, deps } = wiredCoordinator();
    const h0 = await proposeNextHop(deps(), chain.id, null, { auto: true });
    if (h0.kind !== 'advanced') throw new Error('hop0 not advanced');
    await coordinator.markAccepted(h0.delegationId);
    await coordinator.markCompleted(h0.delegationId, { output: {} }); // advances to hop 1
    // A second (racing/stale) completion attempt on the same delegation is a
    // no-op: transition writer stickiness returns null → no second onHopSettled advance.
    await coordinator.markCompleted(h0.delegationId, { output: { evil: true } });
    const { delegations } = await listDelegations(db.pool, { agentId: end.id });
    expect(delegations).toHaveLength(1); // exactly one hop-1 delegation, not two
  });

  it('revoke fan-out on the origin mid-chain terminates the chain (fails safe)', async () => {
    const { chain, origin } = await build2HopChain();
    const { coordinator, deps } = wiredCoordinator();
    const h0 = await proposeNextHop(deps(), chain.id, null, { auto: true });
    if (h0.kind !== 'advanced') throw new Error('hop0 not advanced');
    // The origin is revoked while hop 0 is in flight → the coordinator's revoke
    // fan-out cancels the outbound hop → terminal callback → chain terminates.
    await coordinator.cancelForRevokedAgent(origin.id);
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated');
  });

  it('a tampered next_hop past the plan length completes the chain (defensive, no phantom hop)', async () => {
    const { chain, end } = await build2HopChain();
    const { deps } = wiredCoordinator();
    await db.pool.query(`UPDATE chains SET next_hop = 9, status = 'running' WHERE id = $1`, [chain.id]);
    const out = await proposeNextHop(deps(), chain.id, null, { auto: true });
    expect(out.kind).toBe('completed');
    const { delegations } = await listDelegations(db.pool, { agentId: end.id });
    expect(delegations).toHaveLength(0); // no phantom hop issued
  });

  it('wind-down on the origin mid-chain terminates the chain + cancels the in-flight hop (fails safe)', async () => {
    const { chain, mid, origin } = await build2HopChain();
    const { deps } = wiredCoordinator();
    // Hop 0 is in flight (auto link, spend-incapable → pending) to `mid`.
    const h0 = await proposeNextHop(deps(), chain.id, null, { auto: true });
    if (h0.kind !== 'advanced') throw new Error('hop0 not advanced');
    // Owner winds down the ORIGIN mid-chain (§8 fail-safe, D-4).
    await terminateOriginChainsForWindDown(deps(), origin.id);
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated');
    expect(after?.currentDelegationId).toBeNull();
    // The in-flight hop delegation was cancelled — it can no longer be picked up.
    const { delegations } = await listDelegations(db.pool, { agentId: mid.id });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]!.status).toBe('cancelled');
  });

  it('a planned chain does not resume after wind-down + restart', async () => {
    const { chain, origin } = await build2HopChain(); // 'planned', no hop proposed yet
    const { deps } = wiredCoordinator();
    await terminateOriginChainsForWindDown(deps(), origin.id);
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated');
    // The runtime restart hook (maybeAdvanceChains) reads listAdvancingChainsForOrigin
    // — a terminated chain is gone from it, so hop 0 is never proposed on restart.
    const advancing = await listAdvancingChainsForOrigin(db.pool, origin.id);
    expect(advancing).toHaveLength(0);
    // And a direct re-propose is a no-op (chain not advancing).
    const out = await proposeNextHop(deps(), chain.id, null, { auto: true });
    expect(out.kind).toBe('noop');
  });

  it('settleChainHop is a no-op on a terminated chain (a late completed-outcome cannot resurrect it)', async () => {
    const { chain } = await build2HopChain();
    await terminateChain(db.pool, chain.id);
    // A late/duplicate completed-outcome tries to settle the already-terminated chain.
    const settled = await settleChainHop(db.pool, chain.id, 'completed');
    expect(settled).toBeNull();
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated'); // never resurrected to completed/running
  });

  it('a denied supervised hop (declined before delivery) terminates the chain', async () => {
    // spender target → supervised → owner deny → declined → terminate
    const origin = await seed({});
    const spender = await seed({ type: 'executor' });
    await createLink(db.pool, { ownerAddr: OWNER, fromAgentId: origin.id, toAgentId: spender.id, mode: 'auto' });
    const directionId = await draftFor(origin.id);
    const chain = await insertPlannedChain(db.pool, {
      ownerAddr: OWNER,
      originAgentId: origin.id,
      directionId,
      plan: [{ eligibleTargetIds: [spender.id], directedIntent: 'trade' }],
    });
    const { coordinator, deps } = wiredCoordinator();
    const h0 = await proposeNextHop(deps(), chain.id, null, { auto: true });
    if (h0.kind !== 'advanced') throw new Error('hop0 not advanced');
    expect(h0.supervised).toBe(true);
    await coordinator.onDelegationApprovalDecision(h0.delegationId, 'deny', origin.id);
    const after = await getChain(db.pool, chain.id);
    expect(after?.status).toBe('terminated');
  });
});
