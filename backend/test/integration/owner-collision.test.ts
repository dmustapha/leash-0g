import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { encodeFunctionData } from 'viem';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { getAgentByAccountAndChain } from '../../src/store/agents.js';
import { insertCapabilityRequest, listRequestsByChainAndAccount } from '../../src/store/capabilities.js';
import { computeCallHash } from '../../src/governed-call/index.js';

/**
 * SE-6 pre-req (retargeted SE-5 Gate-② carry #1) — same-chain same-address
 * OWNER isolation. Under CREATE2, two DIFFERENT owners can deterministically
 * hold the SAME account address on the SAME chain. Two guarantees:
 *   1. Owner-scoped reads: neither owner can resolve (or cross-read) the other's
 *      agent / JIT requests through the shared address.
 *   2. DB-level impossibility: within ONE owner, (chain, account) is UNIQUE
 *      (migration 021) — a duplicate insert is refused by the database, never
 *      an arbitrary LIMIT-1 pick at read time.
 */

const OWNER_X = '0x' + '1a'.repeat(20);
const OWNER_Y = '0x' + '2b'.repeat(20);
// ONE account address, deliberately shared by BOTH owners on the SAME chain.
const SHARED_ACCOUNT = '0x' + 'd7'.repeat(20);
const CHAIN = 16602;
const TARGET = '0x' + 'a1'.repeat(20);
const SPENDER = '0x' + 'e5'.repeat(20);

function callData(amount: bigint): string {
  return encodeFunctionData({
    abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'approve',
    args: [SPENDER as `0x${string}`, amount],
  });
}

let db: TestDb;
let agentX: string;
let agentY: string;

beforeAll(async () => {
  db = await createTestDb();
  agentX = await seedAgent(db.pool, { ownerAddr: OWNER_X, accountAddr: SHARED_ACCOUNT, chainId: CHAIN, tokenId: 'tok-x' });
  agentY = await seedAgent(db.pool, { ownerAddr: OWNER_Y, accountAddr: SHARED_ACCOUNT, chainId: CHAIN, tokenId: 'tok-y' });
});
afterAll(async () => {
  await db.drop();
});

describe('SE-6 pre-req: owner-scoped same-address isolation', () => {
  it('two owners sharing (chain, account) each resolve ONLY their own agent', async () => {
    const x = await getAgentByAccountAndChain(db.pool, OWNER_X, CHAIN, SHARED_ACCOUNT);
    const y = await getAgentByAccountAndChain(db.pool, OWNER_Y, CHAIN, SHARED_ACCOUNT);
    expect(x?.id).toBe(agentX);
    expect(x?.ownerAddr).toBe(OWNER_X);
    expect(y?.id).toBe(agentY);
    expect(y?.ownerAddr).toBe(OWNER_Y);
    // A third owner resolving the shared address gets NOTHING — never a
    // silently-picked colliding row (the old ORDER BY … LIMIT 1 hazard).
    expect(await getAgentByAccountAndChain(db.pool, '0x' + '3c'.repeat(20), CHAIN, SHARED_ACCOUNT)).toBeNull();
  });

  it('JIT requests under the shared address never cross-read between owners', async () => {
    const dataX = callData(111n);
    const { row: reqX } = await insertCapabilityRequest(db.pool, {
      agentId: agentX,
      ownerAddr: OWNER_X,
      decoded: { label: 'UNVERIFIED', target: TARGET, selector: '0x095ea7b3' },
      novelty: ['over_cap'],
      callHash: computeCallHash(CHAIN, TARGET, 0n, dataX),
      callTarget: TARGET,
      callValue: '0',
      callData: dataX,
    });
    const dataY = callData(222n);
    const { row: reqY } = await insertCapabilityRequest(db.pool, {
      agentId: agentY,
      ownerAddr: OWNER_Y,
      decoded: { label: 'UNVERIFIED', target: TARGET, selector: '0x095ea7b3' },
      novelty: ['over_cap'],
      callHash: computeCallHash(CHAIN, TARGET, 0n, dataY),
      callTarget: TARGET,
      callValue: '0',
      callData: dataY,
    });

    const forX = await listRequestsByChainAndAccount(db.pool, OWNER_X, CHAIN, SHARED_ACCOUNT);
    const forY = await listRequestsByChainAndAccount(db.pool, OWNER_Y, CHAIN, SHARED_ACCOUNT);
    expect(forX.map((r) => r.id)).toEqual([reqX.id]);
    expect(forY.map((r) => r.id)).toEqual([reqY.id]);
    // Cross-owner reads through the shared address are impossible.
    expect(forX.some((r) => r.id === reqY.id)).toBe(false);
    expect(forY.some((r) => r.id === reqX.id)).toBe(false);
  });

  it('UNIQUE(owner_addr, chain_id, account_addr): a same-owner duplicate is a DB-level impossibility', async () => {
    await expect(
      seedAgent(db.pool, { ownerAddr: OWNER_X, accountAddr: SHARED_ACCOUNT, chainId: CHAIN, tokenId: 'tok-dup' }),
    ).rejects.toThrow(/agents_owner_chain_account|duplicate key/);
    // The same owner + same address on a DIFFERENT chain stays legal (that is the
    // SE-6 cross-chain same-address shape, covered by chain-isolation.test.ts).
    const other = await seedAgent(db.pool, { ownerAddr: OWNER_X, accountAddr: SHARED_ACCOUNT, chainId: 84532, tokenId: 'tok-x-b' });
    expect(other).toBeTruthy();
  });
});
