import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { encodeFunctionData } from 'viem';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { getAgentByAccountAndChain } from '../../src/store/agents.js';
import {
  insertCapabilityRequest,
  listRequestsByChainAndAccount,
  listRecentRequests,
  getCapabilityRequest,
} from '../../src/store/capabilities.js';
import { computeCallHash } from '../../src/governed-call/index.js';

/**
 * SE-5 (E-5) — cross-chain state isolation. The SAME account address can exist on
 * two chains (SE-6 CREATE2 same-address). The read-model is keyed by (chainId,
 * account): a grant/request read on chain A must NEVER resolve chain B's state.
 * This is the cross-chain state-confusion guard (spec §8) — a grant on chain A
 * cannot authorize a call on chain B.
 */

const OWNER = '0x' + '4b'.repeat(20);
// ONE account address, deliberately shared across both chains (CREATE2 shape).
const SHARED_ACCOUNT = '0x' + 'c2'.repeat(20);
const CHAIN_A = 16602; // 0G Galileo
const CHAIN_B = 84532; // Base Sepolia
const TARGET = '0x' + 'a1'.repeat(20);
const SPENDER = '0x' + 'b2'.repeat(20);

function callData(amount: bigint): string {
  return encodeFunctionData({
    abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'approve',
    args: [SPENDER as `0x${string}`, amount],
  });
}

let db: TestDb;
let agentA: string;
let agentB: string;

beforeAll(async () => {
  db = await createTestDb();
  // Two agents, SAME account address, DIFFERENT chains.
  agentA = await seedAgent(db.pool, { ownerAddr: OWNER, accountAddr: SHARED_ACCOUNT, chainId: CHAIN_A, tokenId: 'tok-a' });
  agentB = await seedAgent(db.pool, { ownerAddr: OWNER, accountAddr: SHARED_ACCOUNT, chainId: CHAIN_B, tokenId: 'tok-b' });
});
afterAll(async () => {
  await db.drop();
});

describe('SE-5 cross-chain read-model isolation (E-5)', () => {
  it('resolves the agent by (chainId, account) — the same address disambiguates by chain', async () => {
    const a = await getAgentByAccountAndChain(db.pool, CHAIN_A, SHARED_ACCOUNT);
    const b = await getAgentByAccountAndChain(db.pool, CHAIN_B, SHARED_ACCOUNT);
    expect(a?.id).toBe(agentA);
    expect(a?.chainId).toBe(CHAIN_A);
    expect(b?.id).toBe(agentB);
    expect(b?.chainId).toBe(CHAIN_B);
    // a chain with no agent for that address resolves to nothing (no cross-chain bleed).
    // (Registry-level default-deny for an UNREGISTERED chain is UnregisteredChainError —
    // enforced separately in chain-registry.test.ts; this read layer just returns no row.)
    expect(await getAgentByAccountAndChain(db.pool, 999, SHARED_ACCOUNT)).toBeNull();
  });

  it('a request written under chain A derives chain A and is invisible under chain B', async () => {
    const dataA = callData(111n);
    const { row: reqA } = await insertCapabilityRequest(db.pool, {
      agentId: agentA,
      ownerAddr: OWNER,
      decoded: { label: 'UNVERIFIED', target: TARGET, selector: '0x095ea7b3' },
      novelty: ['over_cap'],
      callHash: computeCallHash(TARGET, 0n, dataA),
      callTarget: TARGET,
      callValue: '0',
      callData: dataA,
    });
    // The row inherited chain A from its agent (subquery-derived, never caller text).
    expect(reqA.chainId).toBe(CHAIN_A);

    const dataB = callData(222n);
    const { row: reqB } = await insertCapabilityRequest(db.pool, {
      agentId: agentB,
      ownerAddr: OWNER,
      decoded: { label: 'UNVERIFIED', target: TARGET, selector: '0x095ea7b3' },
      novelty: ['over_cap'],
      callHash: computeCallHash(TARGET, 0n, dataB),
      callTarget: TARGET,
      callValue: '0',
      callData: dataB,
    });
    expect(reqB.chainId).toBe(CHAIN_B);

    // (chainId, account) reads are isolated — each chain sees ONLY its own request,
    // despite the shared account address.
    const onA = await listRequestsByChainAndAccount(db.pool, CHAIN_A, SHARED_ACCOUNT);
    const onB = await listRequestsByChainAndAccount(db.pool, CHAIN_B, SHARED_ACCOUNT);
    expect(onA.map((r) => r.id)).toEqual([reqA.id]);
    expect(onB.map((r) => r.id)).toEqual([reqB.id]);
    expect(onA.every((r) => r.chainId === CHAIN_A)).toBe(true);
    expect(onB.every((r) => r.chainId === CHAIN_B)).toBe(true);

    // Chain A's request never appears under chain B's read and vice-versa.
    expect(onB.some((r) => r.id === reqA.id)).toBe(false);
    expect(onA.some((r) => r.id === reqB.id)).toBe(false);

    // Agent-scoped reads stay correct too (each agent is single-chain).
    expect((await listRecentRequests(db.pool, agentA)).every((r) => r.chainId === CHAIN_A)).toBe(true);
    expect((await listRecentRequests(db.pool, agentB)).every((r) => r.chainId === CHAIN_B)).toBe(true);
    // Byte integrity intact per row.
    expect((await getCapabilityRequest(db.pool, reqA.id))?.callData).toBe(dataA);
  });
});
