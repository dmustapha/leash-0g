import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import {
  createPublicClient,
  createWalletClient,
  http,
  getCreate2Address,
  keccak256,
  stringToHex,
  toFunctionSelector,
  parseAbi,
  type Hex,
} from 'viem';
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
 * SE-10 (E-11) — a HOME-on-Ethereum-Sepolia agent runs its FULL runtime loop LIVE:
 * Eth Sepolia is PROMOTED from a bridge-destination-only chain (SE-8) to a full
 * governed home chain. The agent row is homed on 11155111; the manager resolves its
 * runtime client through the REAL `ChainRegistry` (`resolveChain`); one cycle runs
 *   sense (live Sepolia reads) → decide (governed `call` intent, never-guess-money
 *   build → `transfer(self)` of a REAL ERC-20) → act (`executeCall` LANDS on the
 *   real WETH token contract, status 1).
 *
 * This is the THIN-REPEAT proof: no new decoder, no new code path — the SAME wall +
 * grammar + runtime a Base-home / 0G-home agent uses, now proven on Eth Sepolia
 * against a real on-chain protocol. Hermetic Neon; only the LLM decision is mocked.
 * Fresh deterministic account per run. Gated behind RUN_DEPLOYED_DRILL=1.
 */

const RUN = process.env.RUN_DEPLOYED_DRILL === '1';

const ETH_SEPOLIA_ID = 11155111;
// Canonical WETH9 on Ethereum Sepolia — a REAL protocol contract on that chain.
const WETH = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9' as Hex;
const SEL_TRANSFER = toFunctionSelector('function transfer(address,uint256)').toLowerCase();
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
const FACTORY_SALT = keccak256(stringToHex('LEASH-V4-DETERMINISTIC-FACTORY-v1'));
const PER_CALL_CAP = 200_000_000_000_000n;
const TRANSFER_AMOUNT = 100_000_000_000_000n;

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

const SEPOLIA_RPC = RUN ? env('ETHEREUM_SEPOLIA_RPC') : 'http://localhost:8545';
const OPS_PK = (RUN ? (env('OPS_PRIVATE_KEY').startsWith('0x') ? env('OPS_PRIVATE_KEY') : `0x${env('OPS_PRIVATE_KEY')}`) : `0x${'11'.repeat(32)}`) as Hex;
const GUARDIAN_PK = (RUN ? (env('GUARDIAN_PRIVATE_KEY').startsWith('0x') ? env('GUARDIAN_PRIVATE_KEY') : `0x${env('GUARDIAN_PRIVATE_KEY')}`) : `0x${'22'.repeat(32)}`) as Hex;
const OPS = privateKeyToAccount(OPS_PK);
const GUARDIAN = privateKeyToAccount(GUARDIAN_PK);
const OWNER = OPS.address.toLowerCase();

const pub = createPublicClient({ chain: zeroGChain(SEPOLIA_RPC, ETH_SEPOLIA_ID), transport: http(SEPOLIA_RPC) });
const wallet = createWalletClient({ chain: zeroGChain(SEPOLIA_RPC, ETH_SEPOLIA_ID), transport: http(SEPOLIA_RPC), account: OPS });

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
      chainId: ETH_SEPOLIA_ID,
      name: 'Ethereum Sepolia',
      rpcUrl: SEPOLIA_RPC,
      factoryV4Addr: factory,
      registryAddr: env('AGENT_REGISTRY_SEPOLIA_ADDR'),
      accountVersion: 4,
      gasFloorWei: 0n,
      // PROMOTION: WETH is an allowlisted real-protocol target on this home chain.
      canonical: { settlementToken: WETH.toLowerCase() },
      protocolAllowlist: [WETH.toLowerCase()],
    },
  ];
  return new ChainRegistry(configs, { opsPrivateKey: OPS_PK, guardianPrivateKey: GUARDIAN_PK });
}

async function send(addr: Hex, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({ chain: wallet.chain, account: OPS, address: addr, abi: leashAccountV4Abi, functionName, args } as never);
  await confirmReceipt(pub, hash);
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

(RUN ? describe : describe.skip)('SE-10 — Eth-Sepolia-home agent FULL runtime loop (LIVE, real protocol)', () => {
  beforeAll(async () => {
    const factory = factoryAddr();
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
    account = await pub.readContract({ address: factory, abi: factoryV4DeterministicAbi, functionName: 'predictAccountV4', args: [...mintArgs] });
    const mintTx = await wallet.writeContract({ chain: wallet.chain, account: OPS, address: factory, abi: factoryV4DeterministicAbi, functionName: 'createAccountV4', args: [...mintArgs] });
    await confirmReceipt(pub, mintTx);

    // grants: a WETH-token budget + the transfer(self) rule (recipientMode 0 = self)
    await send(account, 'proposeSpendBudget', [WETH, PER_CALL_CAP * 4n]);
    await applyWithRetry(account, 'applySpendBudget');
    await send(account, 'proposeCallRule', [WETH, SEL_TRANSFER, 0, [], PER_CALL_CAP, PER_CALL_CAP * 2n, ('0x' + '00'.repeat(32))]);
    await applyWithRetry(account, 'applyCallRule');

    // fund the account with REAL WETH: wrap ETH, then transfer WETH to the account.
    const wrapTx = await wallet.sendTransaction({ chain: wallet.chain, account: OPS, to: WETH, value: TRANSFER_AMOUNT * 4n, data: '0xd0e30db0' });
    await confirmReceipt(pub, wrapTx);
    const fundTx = await wallet.writeContract({
      chain: wallet.chain,
      account: OPS,
      address: WETH,
      abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
      functionName: 'transfer',
      args: [account, TRANSFER_AMOUNT * 2n],
    });
    await confirmReceipt(pub, fundTx);

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
        id: 'cmpl-transfer',
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'call', target: WETH, selector: SEL_TRANSFER, amountWei: TRANSFER_AMOUNT.toString(), reason: 'consolidate treasury WETH into the leashed account (self-transfer)' }) } }],
        x_0g_trace: { provider: '0xprov', request_id: 'req-transfer', billing: { total: 1 } },
      });

    const registry = realRegistry(factory);
    manager = new LeashRuntimeManager({
      pool: db.pool,
      hub: t.hub,
      broker: t.broker,
      chain: registry.getSessionChain(ETH_SEPOLIA_ID),
      resolveChain: (chainId: number) => registry.getSessionChain(chainId),
      chainRegistry: registry,
      checkpointer,
      alerts: t.alerts,
      settings: { keyring: TEST_KEYRING, approvalTimeoutMs: 600_000, gatewayUrl, intervalMs: 6_000, defaultModel: 'test-model', jitTtlMs: 600_000 },
    });
  }, 420_000);

  afterAll(async () => {
    if (manager && agentId) await manager.stop(agentId).catch(() => undefined);
    nock.cleanAll();
    nock.enableNetConnect();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.drop();
  });

  it('sense→decide→act: a governed real-protocol call lands live on Eth Sepolia through the agent-home chain client', async () => {
    const gen = generateGatewayToken();
    agentId = await seedAgent(db.pool, {
      ownerAddr: OWNER,
      accountAddr: account,
      chainId: ETH_SEPOLIA_ID, // ETH-SEPOLIA-HOME agent
      sessionKeyAddr: OPS.address,
      sessionKeyEnc: encryptSecret(OPS_PK, TEST_KEYRING),
      tokenId: gen.tokenId,
      tokenHash: await hashTokenSecret(gen.secret),
      gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
      goal: { beneficiary: WETH, targetBalanceWei: (10n ** 18n).toString(), topUpWei: (10n ** 13n).toString(), model: 'test-model' },
    });
    const rule: CallRule = { target: WETH.toLowerCase(), selector: SEL_TRANSFER, recipientMode: 'self', spenderSet: [], perCallCap: PER_CALL_CAP.toString(), windowCapCall: (PER_CALL_CAP * 2n).toString() };
    await upsertGrant(db.pool, { agentId, ownerAddr: OWNER, rule, source: 'custom', status: 'active' });

    await manager.start(agentId);
    await waitFor(async () => (await listTraces(db.pool, agentId)).some((r) => r.kind === 'action'));
    await manager.stop(agentId);

    const traces = await listTraces(db.pool, agentId);
    const action = traces.find((r) => r.kind === 'action');
    expect(action).toBeTruthy();
    const detail = action?.detail as Record<string, unknown>;
    expect(String(detail?.['summary'])).toContain('governed call');
    expect(String(detail?.['to']).toLowerCase()).toBe(WETH.toLowerCase());
    // the on-chain receipt is a REAL Eth Sepolia tx (per-chain client resolution e2e)
    const txHash = String(detail?.['txHash']) as Hex;
    const receipt = await pub.getTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe('success');
    // trace rows carry the HOME chain id (SE-7 threading live)
    const rows = await db.pool.query<{ chain_id: number }>(`SELECT DISTINCT chain_id FROM trace_records WHERE agent_id = $1`, [agentId]);
    expect(rows.rows.map((r) => Number(r.chain_id))).toEqual([ETH_SEPOLIA_ID]);
  }, 420_000);
});
