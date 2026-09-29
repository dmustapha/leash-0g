import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import nock from 'nock';
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEK, UPSTREAM, type TestApp } from '../helpers/app.js';
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
import { confirmReceipt } from '../../scripts/drill-common.js';

/**
 * C-D1 — Stage-D DEPLOY: the BACKEND-ORCHESTRATED JIT rail proven on the LIVE 0G stack.
 *
 * The runtime decide-node (real `SessionChain` against 0G 16602 + the deployed cfabfdb
 * V4 account) drives the full ALWAYS-ALLOW loop:
 *   agent proposes a NOVEL governed call (over the standing per-call cap)
 *     → runtime live-reads the on-chain grant state, classifies L2, raises a QUARANTINED
 *       capability_request (never a doomed submit, P3C-6) + a `capability_request` alert
 *     → owner GRANTS: loosens the on-chain rule (proposeCallRule→applyCallRule, owner tx)
 *       + decideCapabilityRequest('always_allow') records the standing read-model grant
 *     → the NEXT runtime cycle live-reads the LOOSENED rule, classifies L1, and submits
 *       `executeCall` that LANDS ON-CHAIN (allowance moves) — a real agent-originated
 *       governed call, gated end to end by the on-chain wall.
 *
 * The DB side runs in a hermetic per-run Neon schema (auto-dropped) — zero prod-table
 * pollution; only the on-chain calls touch the real deployed account. Only the LLM money
 * decision is mocked (deterministic, exactly as the CI integration test does); everything
 * else — grant-state live-read, classification, executeCall, receipt — is real.
 *
 * Gated behind RUN_DEPLOYED_DRILL=1 so it never runs in normal CI (needs live 0G + funds).
 *
 * NOTE (findings, documented in STAGE-D-DEPLOY-RESULTS): (1) the create-flow does not yet
 * mint V4 accounts, so the agent here is seeded onto the deployed drill account; (2) the
 * runtime has no approve-once auto-retry path (decideCapabilityRequest never submits) — the
 * approve-once one-shot is proven as an on-chain primitive by contracts/script/jit-drill.sh
 * (5/5), not as a backend retry. This drill proves the always-allow loop, which IS wired.
 */

const RUN = process.env.RUN_DEPLOYED_DRILL === '1';

// cfabfdb redeploy on 0G 16602 (Stage-D DEPLOY 2026-09-28).
const ACCOUNT = '0x2FDbfa0e76D4dC455C95C4e7d445595E714cDCDF';
const USD = '0x4E51f90C8Cf60307E01A6abF555762e69Ef0eC2A';
const ROUTER = '0x425B8638e1B851486F397715EA414d52A1Ab7a65';
const APPROVE = '0x095ea7b3';

// standing per-call cap on the (usd,approve) rule at drill start; the novel amount exceeds it.
const NOVEL_AMOUNT = 250_000_000n; // 250e6 > 200e6 standing cap → classifies L2 (over_cap)
const LOOSENED_CAP = 300_000_000n; // owner loosens perCallCap to ≥ the novel amount
const BIG_WINDOW = 1_000_000_000_000n;

function env(key: string): string {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  throw new Error(`missing ${key} in backend/.env`);
}

// Only touch backend/.env when the drill is actually enabled, so the module imports
// cleanly (and the test skips) in CI where no .env / no live key is present.
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

const publicClient = createPublicClient({ chain: zeroGChain(RPC, 16602), transport: http(RPC) });
const wallet = createWalletClient({ chain: zeroGChain(RPC, 16602), transport: http(RPC), account: OPS });

async function allowance(): Promise<bigint> {
  return publicClient.readContract({
    address: USD,
    abi: [{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'allowance',
    args: [ACCOUNT as Hex, ROUTER as Hex],
  });
}
// SE-4: bounded RPC-flake tolerance — a transient receipt drop/timeout retries; a genuine revert rethrows.
async function send(functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({ chain: wallet.chain, account: OPS, address: ACCOUNT as Hex, abi: leashAccountV4Abi, functionName, args } as never);
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

(RUN ? describe : describe.skip)('C-D1 backend-orchestrated JIT E2E (LIVE 0G stack)', () => {
  beforeAll(async () => {
    // reset the standing (usd,approve) rule to the drill baseline: perCallCap 200e6, big window, spender=router.
    await send('proposeCallRule', [USD, APPROVE, 0, [ROUTER], 200_000_000n, BIG_WINDOW, `0x${'00'.repeat(32)}`]);
    await send('applyCallRule', []);
    // reset the router allowance to 0 (governed approve(router,0) — in-envelope) so PHASE 2's
    // post-grant execution is an OBSERVABLE state change (0 → 250e6), not a false-positive on
    // an allowance left over from a prior run.
    const zeroApprove = encodeFunctionData({ abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'approve', args: [ROUTER as Hex, 0n] });
    await send('executeCall', [USD, 0n, zeroApprove]);

    db = await createTestDb();
    checkpointer = new PostgresSaver(db.pool, undefined, { schema: db.schema });
    await checkpointer.setup();
    t = buildTestApp(db.pool);
    server = t.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    gatewayUrl = `http://127.0.0.1:${addr.port}`;
    // Only the LLM decision is mocked; 0G RPC + Neon pass through (netConnect stays enabled).
    nock(UPSTREAM)
      .persist()
      .post('/v1/chat/completions')
      .reply(200, {
        id: 'cmpl-drill',
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'call', target: USD, selector: APPROVE, amountWei: NOVEL_AMOUNT.toString(), reason: 'approve the router for a swap' }) } }],
        x_0g_trace: { provider: '0xprov', request_id: 'req-drill', billing: { total: 1 } },
      });

    manager = new LeashRuntimeManager({
      pool: db.pool,
      hub: t.hub,
      broker: t.broker,
      chain: new SessionChain({ rpcUrl: RPC, chainId: 16602 }),
      checkpointer,
      alerts: t.alerts,
      settings: { keyEncryptionSecret: TEST_KEK, approvalTimeoutMs: 600_000, gatewayUrl, intervalMs: 6_000, defaultModel: 'test-model', jitTtlMs: 600_000 },
    });
  }, 120_000);

  afterAll(async () => {
    if (manager) await manager.stop(agentId).catch(() => undefined);
    nock.cleanAll();
    nock.enableNetConnect();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.drop();
  });

  let agentId: string;

  it('agent novel call → runtime raises a live JIT request → owner always-allow → next cycle executeCall lands on-chain', async () => {
    const gen = generateGatewayToken();
    agentId = await seedAgent(db.pool, {
      ownerAddr: OWNER,
      accountAddr: ACCOUNT,
      sessionKeyAddr: OPS.address,
      sessionKeyEnc: encryptSecret(OPS_PK, TEST_KEK),
      tokenId: gen.tokenId,
      tokenHash: await hashTokenSecret(gen.secret),
      gatewayTokenEnc: encryptSecret(gen.token, TEST_KEK),
      goal: { beneficiary: ROUTER, targetBalanceWei: (10n ** 18n).toString(), topUpWei: (10n ** 15n).toString(), model: 'test-model' },
    });
    // read-model grant so the capability envelope + grant-state candidates include (usd,approve,router).
    const baseRule: CallRule = { target: USD.toLowerCase(), selector: APPROVE, recipientMode: 'self', spenderSet: [ROUTER.toLowerCase()], perCallCap: '200000000', windowCapCall: BIG_WINDOW.toString() };
    await upsertGrant(db.pool, { agentId, ownerAddr: OWNER, rule: baseRule, source: 'preset:defi_trader', status: 'active' });

    // ── PHASE 1: novel call → runtime raises a quarantined JIT request, no submit ──
    await manager.start(agentId);
    await waitFor(async () => (await listRecentRequests(db.pool, agentId)).length >= 1);
    const [req] = await listRecentRequests(db.pool, agentId);
    expect(req?.status).toBe('pending');
    expect(String(req?.novelty)).toContain('over_cap');
    // the capability_request alert commits in its own tx just after the request row — poll for it.
    await waitFor(async () => (await listAlerts(db.pool, OWNER, { kind: 'capability_request' })).alerts.length >= 1, 40_000);

    // ── PHASE 2: owner grants (on-chain loosen + always-allow), runtime retries → lands ──
    await send('proposeCallRule', [USD, APPROVE, 0, [ROUTER], LOOSENED_CAP, BIG_WINDOW, `0x${'00'.repeat(32)}`]);
    const applyTx = await send('applyCallRule', []);

    const agent = await getAgentById(db.pool, agentId);
    const reqRow = await getCapabilityRequest(db.pool, req!.id);
    if (!agent || !reqRow) throw new Error('agent/request not loaded');
    const grantedRule: CallRule = { ...baseRule, perCallCap: LOOSENED_CAP.toString() };
    const res = await decideCapabilityRequest({ pool: db.pool, hub: t.hub, broker: t.broker, alerts: t.alerts } as CapabilityDeps, agent, reqRow, 'always_allow', { txHash: applyTx, rule: grantedRule });
    expect(res.ok).toBe(true);

    // the next runtime cycle live-reads the loosened rule → classifies L1 → submits executeCall.
    // Gate on the ACTION trace (the runtime actually SUBMITTED), keeping the manager cycling —
    // robust against a polluted allowance value from prior runs.
    await waitFor(async () => (await listTraces(db.pool, agentId)).some((r) => r.kind === 'action'), 150_000);
    const traces = await listTraces(db.pool, agentId);
    const action = traces.find((r) => r.kind === 'action');
    expect(action).toBeTruthy();
    expect(String((action?.detail as Record<string, unknown>)?.['summary'])).toContain('governed call');
    // corroborate on-chain: the governed approve landed within the loosened envelope.
    expect(await allowance()).toBe(NOVEL_AMOUNT);
  }, 300_000);
});
