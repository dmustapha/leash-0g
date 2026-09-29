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
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * L-01 (SE-5.0) — crash-durability for the fire-and-forget one-shot retry. The
 * owner-route trigger (`consumeApprovedOneShot`) is IN-MEMORY; a backend restart
 * mid-retry strands an owner-authorized approve-once (row stays `approved_once`,
 * consume_status NULL|aborted). The periodic sweep (`sweepResumableOneShots`,
 * boot + timer in index.ts) re-drives it. Consume-exactly-once must still hold.
 *
 * This test uses its OWN isolated schema so the sweep's global scan sees exactly
 * the row(s) it seeds (the sweep is deliberately DB-wide in production).
 */

const OWNER = '0x' + '4b'.repeat(20);
const ACCOUNT = '0x' + 'c2'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const TOKEN = '0x' + 'a1'.repeat(20);
const SPENDER = '0x' + 'b2'.repeat(20);
const CAP = 10n ** 16n;

const CALL_DATA = encodeFunctionData({
  abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
  functionName: 'approve',
  args: [SPENDER as `0x${string}`, 2000n],
});
const CALL_HASH = computeCallHash(TOKEN, 0n, CALL_DATA);

class FakeChain implements RuntimeChain {
  public calls: Array<{ target: string; data: string }> = [];
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

async function seedApprovedOnceAgent(): Promise<{ agentId: string; reqId: string }> {
  const gen = generateGatewayToken();
  const agentId = await seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: ACCOUNT,
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

function buildManager(chain: FakeChain): LeashRuntimeManager {
  return new LeashRuntimeManager({
    pool: db.pool,
    hub: new SseHub(),
    broker: new ApprovalBroker(),
    chain,
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
}

describe('L-01 crash-durable one-shot sweep (SE-5.0)', () => {
  it('re-drives a stranded approve-once after a crash and consumes exactly once', async () => {
    const { reqId } = await seedApprovedOnceAgent();

    // Simulate the crash: the trigger NEVER RAN — nothing submitted, row untouched.
    const stranded = await getCapabilityRequest(db.pool, reqId);
    expect(stranded?.status).toBe('approved_once');
    expect(stranded?.consumeStatus).toBeNull();

    const chain = new FakeChain();
    const manager = buildManager(chain);

    const resumed = await manager.sweepResumableOneShots();
    expect(resumed).toBe(1); // the stranded one-shot found + re-driven

    const after = await getCapabilityRequest(db.pool, reqId);
    expect(after?.consumeStatus).toBe('consumed'); // crash-durable: it DID consume
    expect(after?.consumeTxHash).toBeTruthy();
    expect(chain.calls.length).toBe(1); // exactly once

    // Idempotent: a second sweep never double-consumes (row excluded by query + CAS).
    const again = await manager.sweepResumableOneShots();
    expect(again).toBe(0);
    expect(chain.calls.length).toBe(1);
  });
});
