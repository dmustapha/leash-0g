import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { encodeFunctionData } from 'viem';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { TEST_KEK } from '../helpers/app.js';
import { SseHub } from '../../src/sse/hub.js';
import { ApprovalBroker } from '../../src/approvals/broker.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { computeCallHash } from '../../src/governed-call/index.js';
import { insertCapabilityRequest, setRequestDecision, getCapabilityRequest } from '../../src/store/capabilities.js';
import { appendTrace } from '../../src/trace/trace-store.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * SE-7 — the two SE-5 Gate-② carries, RESOLVED now that a real 2nd chain exists:
 *   #2 per-chain one-shot consume/sweep: a one-shot for an agent on chain B is
 *      submitted through chain B's client (resolveChain), NEVER chain A's.
 *   #3 trace chain threading: every trace row carries the agent's chain_id
 *      (subquery-derived from the agents row at append time, never caller text).
 */

const OWNER = '0x' + '5c'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const TOKEN = '0x' + 'a1'.repeat(20);
const SPENDER = '0x' + 'b2'.repeat(20);
const CAP = 10n ** 16n;
const BASE_CHAIN = 84532;

const CALL_DATA = encodeFunctionData({
  abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
  functionName: 'approve',
  args: [SPENDER as `0x${string}`, 2000n],
});
const CALL_HASH = computeCallHash(84532, TOKEN, 0n, CALL_DATA);

class FakeChain implements RuntimeChain {
  public calls: Array<{ target: string; data: string }> = [];
  constructor(public readonly label: string) {}
  public policyView: PolicyView = {
    perTransferCap: CAP,
    windowCap: 3n * CAP,
    windowSeconds: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    allowlist: [],
    revoked: false,
    spentInWindow: 0n,
    windowStart: Math.floor(Date.now() / 1000),
  };
  public oneShotEta = BigInt(Math.floor(Date.now() / 1000) + 3600);
  async getBalance(): Promise<bigint> {
    return 10n ** 18n;
  }
  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }
  async executeTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'ee'.repeat(32) };
  }
  async executeTokenTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(input: { target: string; data: string }): Promise<{ txHash: string }> {
    this.calls.push({ target: input.target, data: input.data });
    return { txHash: '0x' + 'cc'.repeat(32) };
  }
  async getErc20Balance(): Promise<bigint> {
    return 0n;
  }
  async getErc20Allowance(): Promise<bigint> {
    return 0n;
  }
  async getSwapBandPrice18(): Promise<bigint | null> {
    return null;
  }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> {
    return { symbol: '0G', decimals: 18 };
  }
  async readCallGrantState(): Promise<GrantState> {
    return { rules: new Map(), budgets: new Map(), allowlist: new Set() };
  }
  async readOneShotAuth(): Promise<bigint> {
    return this.oneShotEta;
  }
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

async function seedBaseChainApprovedOnce(): Promise<{ agentId: string; reqId: string }> {
  const gen = generateGatewayToken();
  const agentId = await seedAgent(db.pool, {
    ownerAddr: OWNER,
    chainId: BASE_CHAIN, // the agent lives on Base — its one-shot must submit there
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEK),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEK),
    goal: { beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: (50n * CAP).toString(), topUpWei: (CAP / 2n).toString(), model: 'test-model' },
  });
  const { row } = await insertCapabilityRequest(db.pool, {
    agentId,
    ownerAddr: OWNER,
    decoded: { label: 'UNVERIFIED', target: TOKEN, selector: '0x095ea7b3' },
    novelty: ['over_cap'],
    callHash: CALL_HASH,
    callTarget: TOKEN,
    callValue: '0',
    callData: CALL_DATA,
  });
  const decided = await setRequestDecision(db.pool, row.id, 'approved_once', '0x' + 'a0'.repeat(32));
  if (!decided) throw new Error('failed to seed approved_once');
  return { agentId, reqId: row.id };
}

describe('SE-7 carry #2: per-chain one-shot consume/sweep', () => {
  it('a Base-chain one-shot is submitted through BASE\'s client, never the default chain\'s', async () => {
    const { reqId } = await seedBaseChainApprovedOnce();
    const homeChain = new FakeChain('0g');
    const baseChain = new FakeChain('base');
    const resolved: number[] = [];
    const manager = new LeashRuntimeManager({
      pool: db.pool,
      hub: new SseHub(),
      broker: new ApprovalBroker(),
      chain: homeChain, // the default (home) client — must NOT be used
      resolveChain: (chainId) => {
        resolved.push(chainId);
        return chainId === BASE_CHAIN ? baseChain : homeChain;
      },
      checkpointer: new PostgresSaver(db.pool, undefined, { schema: db.schema }),
      settings: {
        keyEncryptionSecret: TEST_KEK,
        approvalTimeoutMs: 600_000,
        gatewayUrl: 'http://127.0.0.1:0',
        intervalMs: 6_000,
        defaultModel: 'test-model',
        jitTtlMs: 600_000,
      },
    });

    const resumed = await manager.sweepResumableOneShots();
    expect(resumed).toBe(1);
    expect(resolved).toEqual([BASE_CHAIN]); // resolved from the AGENT's chainId
    expect(baseChain.calls.length).toBe(1); // submitted on Base
    expect(homeChain.calls.length).toBe(0); // never the default client
    const after = await getCapabilityRequest(db.pool, reqId);
    expect(after?.consumeStatus).toBe('consumed');
  });
});

describe('SE-7 carry #3: trace rows carry the agent\'s chain_id', () => {
  it('appendTrace populates chain_id from the agents row (subquery-derived)', async () => {
    const agentId = await seedAgent(db.pool, { ownerAddr: OWNER, chainId: BASE_CHAIN });
    await appendTrace(db.pool, { agentId, kind: 'decision', detail: { summary: 'chain-threading probe' } });
    const res = await db.pool.query<{ chain_id: string }>(
      `SELECT chain_id FROM trace_records WHERE agent_id = $1`,
      [agentId],
    );
    expect(res.rows).toHaveLength(1);
    expect(Number(res.rows[0]?.chain_id)).toBe(BASE_CHAIN);
    // migration 024: the column is now NOT NULL — a NULL insert is impossible.
    const nn = await db.pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'trace_records' AND column_name = 'chain_id'`,
      [db.schema],
    );
    expect(nn.rows[0]?.is_nullable).toBe('NO');
  });
});
