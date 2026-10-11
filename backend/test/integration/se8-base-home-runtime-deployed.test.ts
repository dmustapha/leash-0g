import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import { createPublicClient, createWalletClient, http, getCreate2Address, keccak256, stringToHex, toFunctionSelector, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEYRING, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import { ChainRegistry, type ChainConfig } from '../../src/chain/registry.js';
import { zeroGChain } from '../../src/chain/ops.js';
import { factoryV4DeterministicAbi, leashAccountV4Abi } from '../../src/chain/abis.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { upsertGrant } from '../../src/store/capabilities.js';
import type { CallRule } from '../../src/governed-call/index.js';
import { confirmReceipt } from '../../scripts/drill-common.js';

/**
 * SE-8 carry #4 — a BASE-HOME agent's FULL runtime loop, LIVE end-to-end:
 * the agent row is homed on Base Sepolia (chainId 84532); the manager resolves
 * its runtime client through the REAL `ChainRegistry` (`resolveChain` — the
 * SE-7 wiring, exercised e2e here); one full cycle runs
 *   sense (live Base reads) → decide (governed BRIDGE intent, never-guess-money
 *   build) → the HARD pre-routing gate (REAL `assertSameAddress` on Base +
 *   Ethereum Sepolia, carry #1) → act (`executeCall` bridgeETHTo(self) LANDS on
 *   the real OP-stack L2StandardBridge, status 1).
 *
 * Hermetic Neon schema; only the LLM decision is mocked. A FRESH deterministic
 * account is minted per run (idempotent). Gated behind RUN_DEPLOYED_DRILL=1.
 */

const RUN = process.env.RUN_DEPLOYED_DRILL === '1';

const BRIDGE = '0x4200000000000000000000000000000000000010' as Hex;
const SEL_BRIDGE_ETH_TO = toFunctionSelector('function bridgeETHTo(address,uint32,bytes)').toLowerCase();
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));
const PER_CALL_CAP = 200_000_000_000_000n;
const BRIDGE_AMOUNT = 100_000_000_000_000n;

function envOpt(key: string): string | null {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  return null;
}
function env(key: string): string {
  const v = envOpt(key);
  if (v === null) throw new Error(`missing ${key} in backend/.env`);
  return v;
}

const BASE_RPC = RUN ? (envOpt('BASE_DRILL_RPC') ?? env('BASE_SEPOLIA_RPC')) : 'http://localhost:8545';
const SEPOLIA_RPC = RUN ? env('ETHEREUM_SEPOLIA_RPC') : 'http://localhost:8545';
const OPS_PK = (RUN ? (env('OPS_PRIVATE_KEY').startsWith('0x') ? env('OPS_PRIVATE_KEY') : `0x${env('OPS_PRIVATE_KEY')}`) : `0x${'11'.repeat(32)}`) as Hex;
const GUARDIAN_PK = (RUN ? (env('GUARDIAN_PRIVATE_KEY').startsWith('0x') ? env('GUARDIAN_PRIVATE_KEY') : `0x${env('GUARDIAN_PRIVATE_KEY')}`) : `0x${'22'.repeat(32)}`) as Hex;
const OPS = privateKeyToAccount(OPS_PK);
const GUARDIAN = privateKeyToAccount(GUARDIAN_PK);
const OWNER = OPS.address.toLowerCase();

const basePub = createPublicClient({ chain: zeroGChain(BASE_RPC, 84532), transport: http(BASE_RPC) });
const baseWallet = createWalletClient({ chain: zeroGChain(BASE_RPC, 84532), transport: http(BASE_RPC), account: OPS });

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let manager: LeashRuntimeManager;
let account: Hex;
let accountSalt: Hex;
let agentId: string;

function factoryAddr(): Hex {
  const artifact = JSON.parse(
    readFileSync(new URL('../../../contracts/out/LeashAccountV4FactoryDeterministic.sol/LeashAccountV4FactoryDeterministic.json', import.meta.url), 'utf8'),
  ) as { bytecode: { object: Hex } };
  return getCreate2Address({ from: CREATE2_DEPLOYER, salt: FACTORY_SALT, bytecodeHash: keccak256(artifact.bytecode.object) });
}

function realRegistry(factory: Hex): ChainRegistry {
  const configs: ChainConfig[] = [
    {
      chainId: 84532,
      name: 'Base Sepolia',
      rpcUrl: BASE_RPC,
      factoryV4Addr: factory,
      registryAddr: env('AGENT_REGISTRY_BASE_ADDR'),
      accountVersion: 4,
      gasFloorWei: 0n,
      bridgeAllowlist: [BRIDGE],
      bridgeDestinations: { [BRIDGE.toLowerCase()]: 11155111 },
    },
    {
      chainId: 11155111,
      name: 'Ethereum Sepolia',
      rpcUrl: SEPOLIA_RPC,
      factoryV4Addr: factory,
      registryAddr: env('AGENT_REGISTRY_SEPOLIA_ADDR'),
      accountVersion: 4,
      gasFloorWei: 0n,
    },
  ];
  return new ChainRegistry(configs, { opsPrivateKey: OPS_PK, guardianPrivateKey: GUARDIAN_PK });
}

async function send(addr: Hex, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await baseWallet.writeContract({ chain: baseWallet.chain, account: OPS, address: addr, abi: leashAccountV4Abi, functionName, args } as never);
  await confirmReceipt(basePub, hash);
  return hash;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function applyWithRetry(addr: Hex, fn: 'applyCallRule' | 'applySpendBudget'): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      await send(addr, fn, []);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(3000);
    }
  }
  throw lastErr;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(2000);
  }
}

(RUN ? describe : describe.skip)('SE-8 carry #4 — Base-home agent FULL runtime loop (LIVE)', () => {
  beforeAll(async () => {
    const factory = factoryAddr();
    // fresh deterministic account on Base (owner == sessionKey == ops, timelock 0)
    accountSalt = `0x${randomBytes(32).toString('hex')}`;
    const policy = { perTransferCap: 10n ** 12n, windowCap: 10n ** 12n, windowSeconds: 3600, expiresAt: 2 ** 31 - 1 };
    const mintArgs = [
      OPS.address,
      GUARDIAN.address,
      OPS.address,
      { perTransferCap: policy.perTransferCap, windowCap: policy.windowCap, windowSeconds: policy.windowSeconds, expiresAt: BigInt(policy.expiresAt) },
      [] as Hex[],
      0n,
      ('0x' + '00'.repeat(20)) as Hex,
      { perTransferCapToken: 0n, windowCapToken: 0n },
      accountSalt,
    ] as const;
    account = (await basePub.readContract({ address: factory, abi: factoryV4DeterministicAbi, functionName: 'predictAccountV4', args: [...mintArgs] }));
    const mintTx = await baseWallet.writeContract({ chain: baseWallet.chain, account: OPS, address: factory, abi: factoryV4DeterministicAbi, functionName: 'createAccountV4', args: [...mintArgs] });
    await confirmReceipt(basePub, mintTx);
    // grants: native budget + the bridgeETHTo rule (recipientMode 0 = self)
    await send(account, 'proposeSpendBudget', [('0x' + '00'.repeat(20)), PER_CALL_CAP * 2n]);
    await applyWithRetry(account, 'applySpendBudget');
    await send(account, 'proposeCallRule', [BRIDGE, SEL_BRIDGE_ETH_TO, 0, [], PER_CALL_CAP, PER_CALL_CAP * 2n, ('0x' + '00'.repeat(32))]);
    await applyWithRetry(account, 'applyCallRule');
    const fund = await baseWallet.sendTransaction({ chain: baseWallet.chain, account: OPS, to: account, value: BRIDGE_AMOUNT * 4n });
    await confirmReceipt(basePub, fund);

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
        id: 'cmpl-bridge',
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'call', target: BRIDGE, selector: SEL_BRIDGE_ETH_TO, amountWei: BRIDGE_AMOUNT.toString(), reason: 'bridge treasury float to the same-address far-chain account' }) } }],
        x_0g_trace: { provider: '0xprov', request_id: 'req-bridge', billing: { total: 1 } },
      });

    const registry = realRegistry(factory);
    manager = new LeashRuntimeManager({
      pool: db.pool,
      hub: t.hub,
      broker: t.broker,
      // deliberately NOT a Base client: the manager must resolve the agent's
      // HOME chain through the registry (SE-7 wiring, proven e2e here).
      chain: registry.getSessionChain(11155111),
      resolveChain: (chainId: number) => registry.getSessionChain(chainId),
      chainRegistry: registry,
      checkpointer,
      alerts: t.alerts,
      settings: { keyring: TEST_KEYRING, approvalTimeoutMs: 600_000, gatewayUrl, intervalMs: 6_000, defaultModel: 'test-model', jitTtlMs: 600_000 },
    });
  }, 300_000);

  afterAll(async () => {
    if (manager && agentId) await manager.stop(agentId).catch(() => undefined);
    nock.cleanAll();
    nock.enableNetConnect();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.drop();
  });

  it('sense→decide→pre-routing gate→act: a governed bridge lands on live Base through the agent-home chain client', async () => {
    const gen = generateGatewayToken();
    agentId = await seedAgent(db.pool, {
      ownerAddr: OWNER,
      accountAddr: account,
      chainId: 84532, // BASE-HOME agent
      sessionKeyAddr: OPS.address,
      sessionKeyEnc: encryptSecret(OPS_PK, TEST_KEYRING),
      tokenId: gen.tokenId,
      tokenHash: await hashTokenSecret(gen.secret),
      gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
      goal: { beneficiary: BRIDGE, targetBalanceWei: (10n ** 18n).toString(), topUpWei: (10n ** 13n).toString(), model: 'test-model' },
    });
    // the persisted tuple + salt the pre-routing gate replays (byte-exact mint tuple)
    const persistedTuple = {
      ownerAddr: OWNER,
      guardianAddr: GUARDIAN.address.toLowerCase(),
      sessionKeyAddr: OPS.address.toLowerCase(),
      policy: { perTransferCap: (10n ** 12n).toString(), windowCap: (10n ** 12n).toString(), windowSeconds: 3600, expiresAt: 2 ** 31 - 1 },
      allowlist: [] as string[],
      timelockDelay: 0,
      settlementToken: '0x' + '00'.repeat(20),
      tokenPolicy: { perTransferCapToken: '0', windowCapToken: '0' },
    };
    await db.pool.query(`UPDATE agents SET account_version = 4, account_salt = $2, account_create_tuple = $3 WHERE id = $1`, [agentId, accountSalt, JSON.stringify(persistedTuple)]);
    const rule: CallRule = { target: BRIDGE.toLowerCase(), selector: SEL_BRIDGE_ETH_TO, recipientMode: 'self', spenderSet: [], perCallCap: PER_CALL_CAP.toString(), windowCapCall: (PER_CALL_CAP * 2n).toString() };
    await upsertGrant(db.pool, { agentId, ownerAddr: OWNER, rule, source: 'custom', status: 'active' });

    const balanceBefore = await basePub.getBalance({ address: account });
    await manager.start(agentId);
    await waitFor(async () => (await listTraces(db.pool, agentId)).some((r) => r.kind === 'action'));
    await manager.stop(agentId);

    const traces = await listTraces(db.pool, agentId);
    const action = traces.find((r) => r.kind === 'action');
    expect(action).toBeTruthy();
    const detail = action?.detail as Record<string, unknown>;
    expect(String(detail?.['summary'])).toContain('governed call');
    expect(String(detail?.['to']).toLowerCase()).toBe(BRIDGE.toLowerCase());
    // corroborate LIVE on Base: the bridged value left the account (the bridge
    // leg landed on the real L2StandardBridge — only possible if the pre-routing
    // gate PASSED, since a refusal stands down before any submit).
    const balanceAfter = await basePub.getBalance({ address: account });
    expect(balanceBefore - balanceAfter >= BRIDGE_AMOUNT).toBe(true);
    // and the on-chain receipt is a REAL Base tx (per-chain client resolution e2e)
    const txHash = String(detail?.['txHash']) as Hex;
    const receipt = await basePub.getTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe('success');
    // SE-7 trace threading live: every trace row carries the HOME chain id
    const rows = await db.pool.query<{ chain_id: number }>(`SELECT DISTINCT chain_id FROM trace_records WHERE agent_id = $1`, [agentId]);
    expect(rows.rows.map((r) => Number(r.chain_id))).toEqual([84532]);
  }, 420_000);
});
