import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import nock from 'nock';
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEYRING, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { SessionChain } from '../../src/runtime/session-chain.js';
import { zeroGChain } from '../../src/chain/ops.js';
import { leashAccountV4Abi } from '../../src/chain/abis.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { listAlerts } from '../../src/alerts/store.js';
import { upsertGrant, listRecentRequests, getCapabilityRequest } from '../../src/store/capabilities.js';
import { getAgentById } from '../../src/store/agents.js';
import { decideCapabilityRequest, type CapabilityDeps } from '../../src/capabilities/service.js';
import type { CallRule } from '../../src/governed-call/index.js';
import { confirmReceipt, isFlake } from '../../scripts/drill-common.js';

/**
 * SE-4 E-4 / SE-2 E-3 [DEPLOY] — the FULL backend-orchestrated one-shot-consume loop proven on
 * the LIVE 0G stack (the SE-2 [DEPLOY] proof, deferred from Stage D into SE-4):
 *
 *   agent proposes a NOVEL over-cap governed call
 *     → runtime live-reads on-chain grant state, classifies L2 (over_cap), raises a QUARANTINED
 *       capability_request + a `capability_request` alert (NO submit — P3C-6 no-doomed-submit)
 *     → owner APPROVE-ONCE: authorizeOnce(callHash) on-chain (owner tx, client-side signed) +
 *       decideCapabilityRequest('approve_once') persists the decision (bytes already stored at raise)
 *     → manager.consumeApprovedOneShot auto-retries the EXACT refused bytes → the on-chain
 *       one-shot is CONSUMED EXACTLY ONCE (OneShotConsumed; the call lands, allowance moves)
 *     → a replay is REFUSED: the off-chain CAS stands down (no second submit) AND the on-chain
 *       one-shot is deleted-on-use (a direct re-submit reverts at the wall).
 *   Fail-safe (a flaked/reverted receipt = failed-not-acted, never a phantom action) is the
 *   E-3 [CI] 7/7 suite's receipt-flake case; here the delete-on-use replay-refusal is the live
 *   analogue that no phantom double-spend is possible.
 *
 * SE-4 idempotent: a baseline-reset preamble restores the canonical (usd,approve) rule
 * (perCallCap 200e6) so the novel 250e6 always classifies over_cap on re-run; owner txs use a
 * bounded RPC-flake retry (drill-common). Hermetic per-run Neon (auto-dropped); real SessionChain
 * vs 0G 16602; only the LLM money decision is mocked. Gated behind RUN_DEPLOYED_DRILL=1.
 */

const RUN = process.env.RUN_DEPLOYED_DRILL === '1';

// cfabfdb redeploy on 0G 16602 (Stage-D DEPLOY 2026-09-28).
const ACCOUNT = '0x2FDbfa0e76D4dC455C95C4e7d445595E714cDCDF' as Hex;
const USD = '0x4E51f90C8Cf60307E01A6abF555762e69Ef0eC2A' as Hex;
const ROUTER = '0x425B8638e1B851486F397715EA414d52A1Ab7a65' as Hex;
const APPROVE = '0x095ea7b3' as Hex;

const BASELINE_CAP = 200_000_000n; // canonical standing per-call cap (reset restores it)
const NOVEL_AMOUNT = 250_000_000n; // 250e6 > 200e6 cap → over_cap → L2 one-shot path
const BIG_WINDOW = 1_000_000_000_000n;

function env(key: string): string {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  throw new Error(`missing ${key} in backend/.env`);
}

const RPC = RUN ? env('ZERO_G_RPC') : 'http://localhost:8545';
const OPS_PK = (RUN ? (env('OPS_PRIVATE_KEY').startsWith('0x') ? env('OPS_PRIVATE_KEY') : `0x${env('OPS_PRIVATE_KEY')}`) : `0x${'11'.repeat(32)}`) as Hex;
const OPS = privateKeyToAccount(OPS_PK);
const OWNER = OPS.address.toLowerCase();

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let manager: LeashRuntimeManager;
let agentId: string;

const publicClient = createPublicClient({ chain: zeroGChain(RPC, 16602), transport: http(RPC) });
const wallet = createWalletClient({ chain: zeroGChain(RPC, 16602), transport: http(RPC), account: OPS });

async function allowance(): Promise<bigint> {
  const v = await publicClient.readContract({
    address: USD,
    abi: [{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'allowance',
    args: [ACCOUNT, ROUTER],
  });
  return v;
}
// bounded RPC-flake-tolerant owner tx (a genuine revert rethrows; a receipt drop/timeout retries).
async function send(functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({ chain: wallet.chain, account: OPS, address: ACCOUNT, abi: leashAccountV4Abi, functionName, args } as never);
  await confirmReceipt(publicClient, hash); // re-polls the same hash; tolerates 0G receipt drops, no double-submit
  return hash;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(2000);
  }
}

const evidence: Record<string, unknown> = { drill: 'SE-2/SE-4 one-shot-consume [DEPLOY]', chainId: 16602, account: ACCOUNT };

(RUN ? describe : describe.skip)('SE-2/SE-4 one-shot-consume backend loop (LIVE 0G stack)', () => {
  beforeAll(async () => {
    // BASELINE RESET (idempotent): restore the canonical (usd,approve) rule so the novel 250e6
    // is over the 200e6 cap on EVERY run regardless of a prior run's residue (timelock 0 → instant).
    await send('proposeCallRule', [USD, APPROVE, 0, [ROUTER], BASELINE_CAP, BIG_WINDOW, `0x${'00'.repeat(32)}`]);
    await send('applyCallRule', []);
    // Zero the router allowance (governed approve(router,0) — 0 ≤ cap, in-envelope) so the
    // consume-landed assertion (allowance == 250e6) is an OBSERVABLE 0→250e6 delta, not a
    // false-positive on a prior run's residual 250e6 allowance.
    const zeroApprove = encodeFunctionData({ abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'approve', args: [ROUTER, 0n] });
    await send('executeCall', [USD, 0n, zeroApprove]);
    evidence.resetCanonicalCap = BASELINE_CAP.toString();

    db = await createTestDb();
    checkpointer = new PostgresSaver(db.pool, undefined, { schema: db.schema });
    await checkpointer.setup();
    t = buildTestApp(db.pool);
    server = t.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    gatewayUrl = `http://127.0.0.1:${addr.port}`;
    nock(UPSTREAM)
      .persist()
      .post('/v1/chat/completions')
      .reply(200, {
        id: 'cmpl-osc',
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'call', target: USD, selector: APPROVE, amountWei: NOVEL_AMOUNT.toString(), reason: 'approve the router for a swap (novel over-cap)' }) } }],
        x_0g_trace: { provider: '0xprov', request_id: 'req-osc', billing: { total: 1 } },
      });

    manager = new LeashRuntimeManager({
      pool: db.pool,
      hub: t.hub,
      broker: t.broker,
      chain: new SessionChain({ rpcUrl: RPC, chainId: 16602 }),
      checkpointer,
      alerts: t.alerts,
      settings: { keyring: TEST_KEYRING, approvalTimeoutMs: 600_000, gatewayUrl, intervalMs: 6_000, defaultModel: 'test-model', jitTtlMs: 600_000 },
    });
  }, 180_000);

  afterAll(async () => {
    if (manager && agentId) await manager.stop(agentId).catch(() => undefined);
    nock.cleanAll();
    nock.enableNetConnect();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) {
      const out = new URL('../../../docs/evidence/stage-e-one-shot-consume-drill.json', import.meta.url);
      writeFileSync(out, JSON.stringify({ ...evidence, at: new Date().toISOString() }, null, 2));
      await db.drop();
    }
  });

  it('novel over-cap call → JIT raise → owner approve_once → consumed exactly once → replay refused (live)', async () => {
    const gen = generateGatewayToken();
    agentId = await seedAgent(db.pool, {
      ownerAddr: OWNER,
      accountAddr: ACCOUNT,
      sessionKeyAddr: OPS.address,
      sessionKeyEnc: encryptSecret(OPS_PK, TEST_KEYRING),
      tokenId: gen.tokenId,
      tokenHash: await hashTokenSecret(gen.secret),
      gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
      goal: { beneficiary: ROUTER, targetBalanceWei: (10n ** 18n).toString(), topUpWei: (10n ** 15n).toString(), model: 'test-model' },
    });
    const baseRule: CallRule = { target: USD.toLowerCase(), selector: APPROVE, recipientMode: 'self', spenderSet: [ROUTER.toLowerCase()], perCallCap: BASELINE_CAP.toString(), windowCapCall: BIG_WINDOW.toString() };
    await upsertGrant(db.pool, { agentId, ownerAddr: OWNER, rule: baseRule, source: 'preset:defi_trader', status: 'active' });

    // ── PHASE 1: novel over-cap call → runtime raises a quarantined JIT request, NO submit ──
    await manager.start(agentId);
    await waitFor(async () => (await listRecentRequests(db.pool, agentId)).length >= 1);
    const [req] = await listRecentRequests(db.pool, agentId);
    if (!req) throw new Error('no capability request raised');
    const reqId = req.id;
    expect(req.status).toBe('pending');
    expect(String(req.novelty)).toContain('over_cap');
    await waitFor(async () => (await listAlerts(db.pool, OWNER, { kind: 'capability_request' })).alerts.length >= 1, 40_000);
    // stop the loop so the one-shot consume (fired by the approve_once route, not the loop) is
    // the sole actor — deterministic; the loop never consumes one-shots anyway.
    await manager.stop(agentId);
    evidence.raised = { requestId: reqId, novelty: req.novelty, callHash: req.callHash };

    // ── PHASE 2: owner APPROVE-ONCE (on-chain authorizeOnce for the EXACT callHash) ──
    const reqRow0 = await getCapabilityRequest(db.pool, reqId);
    if (!reqRow0?.callHash) throw new Error('request missing callHash');
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const authTx = await send('authorizeOnce', [reqRow0.callHash, expiry]);
    const agent = await getAgentById(db.pool, agentId);
    const reqRow = await getCapabilityRequest(db.pool, reqId);
    if (!agent || !reqRow) throw new Error('agent/request not loaded');
    const decided = await decideCapabilityRequest(
      { pool: db.pool, hub: t.hub, broker: t.broker, alerts: t.alerts } as CapabilityDeps,
      agent, reqRow, 'approve_once', { txHash: authTx },
    );
    expect(decided.ok).toBe(true);
    evidence.approveOnce = { authorizeOnceTx: authTx };

    // ── PHASE 3: runtime auto-retries → consumes the one-shot EXACTLY ONCE (the call lands) ──
    await manager.consumeApprovedOneShot(agentId, reqId);
    await waitFor(async () => (await getCapabilityRequest(db.pool, reqId))?.consumeStatus === 'consumed', 120_000);
    const consumed = await getCapabilityRequest(db.pool, reqId);
    expect(consumed?.consumeStatus).toBe('consumed');
    expect(consumed?.consumeTxHash).toBeTruthy();
    const traces = await listTraces(db.pool, agentId);
    const action = traces.find((r) => r.kind === 'action');
    expect(action).toBeTruthy();
    expect(String((action?.detail as Record<string, unknown>)?.['summary'])).toContain('consumed approve-once one-shot');
    // corroborate on-chain: the exact governed approve landed (allowance == the novel amount).
    expect(await allowance()).toBe(NOVEL_AMOUNT);
    evidence.consumed = { consumeTxHash: consumed?.consumeTxHash, allowance: NOVEL_AMOUNT.toString() };

    // ── PHASE 4a: off-chain replay refused — a second consume stands down, no second submit ──
    await manager.consumeApprovedOneShot(agentId, reqId);
    const afterReplay = await getCapabilityRequest(db.pool, reqId);
    expect(afterReplay?.consumeStatus).toBe('consumed'); // unchanged — CAS refused the replay
    const actionsAfter = (await listTraces(db.pool, agentId)).filter((r) => r.kind === 'action').length;
    expect(actionsAfter).toBe(1); // no phantom second action

    // ── PHASE 4b: on-chain delete-on-use — a direct re-submit of the exact bytes reverts ──
    const exactBytes = encodeFunctionData({ abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'approve', args: [ROUTER, NOVEL_AMOUNT] });
    let onChainReplayRefused = false;
    let replayDetail = 'call unexpectedly succeeded';
    try {
      await publicClient.call({ account: OPS.address, to: ACCOUNT, data: encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'executeCall', args: [USD, 0n, exactBytes] }) });
    } catch (e) {
      // A transient RPC flake here is INCONCLUSIVE — never scored as "refused" (throw → re-run).
      // This is the key E-13 fix: a flake can no longer masquerade as the delete-on-use proof.
      if (isFlake(e)) throw new Error(`on-chain replay probe flaked — inconclusive, re-run: ${String(e).slice(0, 120)}`);
      const msg = String((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message);
      // Soundness (why a genuine revert here IS the delete-on-use proof, not a hollow assert):
      // the IDENTICAL bytes SUCCEEDED in Phase 3 (allowance moved 0→250e6); the only thing that
      // changed is the one-shot was consumed. So the same call now reverting = the one-shot is
      // gone. 0G's eth_call does NOT surface the custom-error selector to viem ("execution
      // reverted for an unknown reason"), unlike `cast` in the bash drills — so we match the
      // selector opportunistically but accept a generic (non-flake) revert as the refusal.
      onChainReplayRefused = /2671b8a6|OverPerCallCap|execution reverted|revert/i.test(msg);
      replayDetail = msg.slice(0, 160);
    }
    expect(onChainReplayRefused).toBe(true);
    evidence.replayRefused = { offChain: 'CAS stood down (no 2nd submit)', onChain: replayDetail };
  }, 420_000);
});
