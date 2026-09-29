import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { encodeFunctionData, encodeErrorResult } from 'viem';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { TEST_KEK } from '../helpers/app.js';
import { SseHub } from '../../src/sse/hub.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { consumeOneShot, type OneShotConsumeCtx } from '../../src/runtime/one-shot-consume.js';
import { computeCallHash } from '../../src/governed-call/index.js';
import {
  insertCapabilityRequest,
  setRequestDecision,
  getCapabilityRequest,
} from '../../src/store/capabilities.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * SE-2 (SD-E2, E-3) — the runtime one-shot-consume path. After the owner picks
 * approve_once, the runtime auto-retries the originally-refused call and consumes
 * the on-chain one-shot EXACTLY ONCE; a replay is refused; a mid-cycle
 * revoke/expiry aborts the retry (P3C-6); a flaked receipt is failed-not-acted.
 */

const OWNER = '0x' + '4b'.repeat(20);
const ACCOUNT = '0x' + 'c2'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const TOKEN = '0x' + 'a1'.repeat(20);
const SPENDER = '0x' + 'b2'.repeat(20);
const CAP = 10n ** 16n;

/** The exact refused bytes — approve(SPENDER, 2000) over per-call cap (server-authored). */
const CALL_DATA = encodeFunctionData({
  abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
  functionName: 'approve',
  args: [SPENDER as `0x${string}`, 2000n],
});
const CALL_HASH = computeCallHash(TOKEN, 0n, CALL_DATA);

class FakeChain implements RuntimeChain {
  public calls: Array<{ target: string; data: string }> = [];
  public throwOnExecute: string | null = null;
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
  /** on-chain oneShotAuthEta — future by default (authorized, unconsumed). */
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
    if (this.throwOnExecute) throw new Error(this.throwOnExecute);
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
let hub: SseHub;
let chain: FakeChain;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => {
  hub = new SseHub();
  chain = new FakeChain();
});

async function seedRuntimeAgent(): Promise<string> {
  const gen = generateGatewayToken();
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: ACCOUNT,
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEK),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEK),
    goal: { beneficiary: '0x' + '9c'.repeat(20), targetBalanceWei: (50n * CAP).toString(), topUpWei: (CAP / 2n).toString(), model: 'test-model' },
  });
}

/** Seed a capability_request that the owner has approved-once (bytes persisted). */
async function seedApprovedOnce(agentId: string): Promise<string> {
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
  return row.id;
}

function ctx(agentId: string): OneShotConsumeCtx {
  return { agentId, accountAddr: ACCOUNT, sessionPrivateKey: SESSION_PK };
}

describe('SE-2 runtime one-shot-consume (E-3)', () => {
  it('consumes the on-chain one-shot exactly once: the exact refused call lands', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);

    const outcome = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);

    expect(outcome.type).toBe('consumed');
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.target).toBe(TOKEN);
    expect(chain.calls[0]?.data).toBe(CALL_DATA);

    const req = await getCapabilityRequest(db.pool, reqId);
    expect(req?.consumeStatus).toBe('consumed');
    expect(req?.consumeTxHash).toBe('0x' + 'cc'.repeat(32));

    const traces = await listTraces(db.pool, id);
    const action = traces.find((r) => r.kind === 'action');
    expect(action).toBeTruthy();
    expect(String((action?.detail as Record<string, unknown>)?.['summary'])).toContain('consumed approve-once one-shot');
  });

  it('refuses a replay: a second consume attempt stands down, never submits again', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);

    const first = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);
    expect(first.type).toBe('consumed');

    const replay = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);
    expect(replay.type).toBe('stood_down');
    expect(chain.calls).toHaveLength(1); // no second submit — consume-once
  });

  it('aborts on a mid-cycle revoke (P3C-6 no-doomed-submit)', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);
    chain.policyView = { ...chain.policyView, revoked: true };

    const outcome = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);

    expect(outcome.type).toBe('stood_down');
    if (outcome.type === 'stood_down') expect(outcome.reason).toContain('revoked');
    expect(chain.calls).toHaveLength(0); // never a doomed submit
    const req = await getCapabilityRequest(db.pool, reqId);
    expect(req?.consumeStatus).toBe('aborted');
  });

  it('aborts on a mid-cycle expiry (session lapsed since approval)', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);
    chain.policyView = { ...chain.policyView, expiresAt: Math.floor(Date.now() / 1000) - 10 };

    const outcome = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);

    expect(outcome.type).toBe('stood_down');
    if (outcome.type === 'stood_down') expect(outcome.reason).toContain('expired');
    expect(chain.calls).toHaveLength(0);
  });

  it('stands down retryable when the one-shot is not yet live on-chain (authorizeOnce still confirming)', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);
    chain.oneShotEta = 0n; // authorizeOnce not mined yet (or revoked/consumed)

    const outcome = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);

    expect(outcome.type).toBe('stood_down');
    // retryable → the manager's bounded backoff re-attempts (the request stays
    // re-claimable) so a slightly-late authorizeOnce still gets consumed.
    if (outcome.type === 'stood_down') expect(outcome.retryable).toBe(true);
    expect(chain.calls).toHaveLength(0); // never a doomed submit
    const req = await getCapabilityRequest(db.pool, reqId);
    expect(req?.consumeStatus).toBe('aborted'); // re-claimable for the retry
  });

  it('the terminal aborts (revoke/expiry) are NOT retryable', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);
    chain.policyView = { ...chain.policyView, revoked: true };

    const outcome = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);
    expect(outcome.type).toBe('stood_down');
    if (outcome.type === 'stood_down') expect(outcome.retryable).toBe(false);
  });

  it('fail-safe: a DECODED on-chain revert is a TERMINAL failed decision, never a phantom action', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);
    // A genuine on-chain refusal — a decodable LeashError revert (assertReceiptSuccess
    // surfaces the revert data). This is terminal: re-approving is the owner's call.
    chain.throwOnExecute = `execute reverted on-chain: ${encodeErrorResult({
      abi: [{ type: 'error', name: 'AccountRevoked', inputs: [] }],
      errorName: 'AccountRevoked',
    })}`;

    const outcome = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);

    expect(outcome.type).toBe('failed');
    const req = await getCapabilityRequest(db.pool, reqId);
    expect(req?.consumeStatus).toBe('failed'); // terminal, NOT re-claimable
    const traces = await listTraces(db.pool, id);
    expect(traces.some((r) => r.kind === 'action')).toBe(false); // never recorded as acted
  });

  it('M-01: an UNDECODABLE transport error leaves the one-shot RE-CLAIMABLE (aborted), never terminal', async () => {
    const id = await seedRuntimeAgent();
    const reqId = await seedApprovedOnce(id);
    // A transport blip — RPC flake / nonce / gas / dropped receipt. Undecodable as a
    // LeashError. The owner's authorizeOnce may have landed; a terminal `failed`
    // would silently waste it. So: aborted (re-claimable) + retryable.
    chain.throwOnExecute = 'socket hang up: ETIMEDOUT while waiting for receipt';

    const outcome = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);

    expect(outcome.type).toBe('stood_down');
    if (outcome.type === 'stood_down') expect(outcome.retryable).toBe(true);
    const req = await getCapabilityRequest(db.pool, reqId);
    expect(req?.consumeStatus).toBe('aborted'); // re-claimable — the bounded retry recovers
    const traces = await listTraces(db.pool, id);
    expect(traces.some((r) => r.kind === 'action')).toBe(false); // never recorded as acted

    // Prove re-claimability: a follow-up attempt (transport recovered) consumes exactly once.
    chain.throwOnExecute = null;
    const retry = await consumeOneShot({ pool: db.pool, hub, chain }, ctx(id), reqId);
    expect(retry.type).toBe('consumed');
    const after = await getCapabilityRequest(db.pool, reqId);
    expect(after?.consumeStatus).toBe('consumed');
    expect(chain.calls.length).toBe(1);
  });
});
