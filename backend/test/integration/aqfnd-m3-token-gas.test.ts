import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import nock from 'nock';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, TEST_KEYRING, UPSTREAM, type TestApp } from '../helpers/app.js';
import { generateGatewayToken, hashTokenSecret } from '../../src/crypto/token.js';
import { encryptSecret } from '../../src/crypto/keycrypt.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { listAlerts } from '../../src/alerts/store.js';
import { LeashRuntimeManager } from '../../src/runtime/manager.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import type { GrantState } from '../../src/governed-call/index.js';
import type { PolicyView } from '../../src/types.js';

/**
 * AQ-FND M-3 — the token-denominated treasury top-up wires through the act path:
 *  (a) a spendable token routes to executeTokenTransfer (the self-funding act);
 *  (b) an UNGOVERNED token (no enabled policy / beneficiary not a payee) raises
 *      EXACTLY ONE owner ask and stands down — spend-novel = one ask, never a stall.
 */

const OWNER = '0x' + '4b'.repeat(20);
const BENEFICIARY = '0x' + '9c'.repeat(20);
const TOKEN = '0x' + 'ec'.repeat(20);
const SESSION_PK = '0x' + '6d'.repeat(32);
const SESSION_ADDR = '0x' + 'cb'.repeat(20);
const CAP = 10n ** 16n;

class FakeRuntimeChain implements RuntimeChain {
  public balances = new Map<string, bigint>();
  public tokenTransfers: Array<{ token: string; to: string; amountWei: bigint }> = [];
  /** per-token: enabled + the lowercased payees allowlisted for it. */
  public tokenEnabled = true;
  public tokenPayees: string[] = [BENEFICIARY.toLowerCase()];
  /** the beneficiary's balance in TOKEN (0 ⇒ a top-up is warranted). */
  public beneficiaryTokenBalance = 0n;
  public policyView: PolicyView = {
    perTransferCap: CAP,
    windowCap: 3n * CAP,
    windowSeconds: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    allowlist: [BENEFICIARY],
    revoked: false,
    spentInWindow: 0n,
    windowStart: Math.floor(Date.now() / 1000),
  };

  async getBalance(addr: string): Promise<bigint> {
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }
  async getPolicyView(): Promise<PolicyView> {
    return this.policyView;
  }
  async getErc20Balance(_token: string, owner: string): Promise<bigint> {
    return owner.toLowerCase() === BENEFICIARY.toLowerCase() ? this.beneficiaryTokenBalance : 0n;
  }
  async getAssetPolicy(_acct: string, token: string, payeeCandidates: string[]) {
    const isNative = token.toLowerCase() === '0x0000000000000000000000000000000000000000';
    const set = new Set(isNative ? [] : this.tokenPayees);
    return {
      enabled: isNative ? true : this.tokenEnabled,
      allowedPayees: payeeCandidates.map((p) => p.toLowerCase()).filter((p) => set.has(p)),
    };
  }
  async executeTransfer(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'ee'.repeat(32) };
  }
  async executeTokenTransfer(input: { token: string; to: string; amountWei: bigint }): Promise<{ txHash: string }> {
    this.tokenTransfers.push({ token: input.token, to: input.to, amountWei: input.amountWei });
    return { txHash: '0x' + 'dd'.repeat(32) };
  }
  async executeCall(): Promise<{ txHash: string }> {
    return { txHash: '0x' + 'cc'.repeat(32) };
  }
  async getErc20Allowance(): Promise<bigint> {
    return 0n;
  }
  async getSwapBandPrice18(): Promise<bigint | null> {
    return null;
  }
  async getErc20Meta(): Promise<{ symbol: string; decimals: number }> {
    return { symbol: 'AQB', decimals: 18 };
  }
  async readCallGrantState(): Promise<GrantState> {
    return { rules: new Map(), budgets: new Map(), allowlist: new Set() };
  }
}

let db: TestDb;
let t: TestApp;
let server: Server;
let gatewayUrl: string;
let checkpointer: PostgresSaver;
let fakeChain: FakeRuntimeChain;
let manager: LeashRuntimeManager;
const startedAgents: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  checkpointer = new PostgresSaver(db.pool, undefined, { schema: db.schema });
  await checkpointer.setup();
  t = buildTestApp(db.pool);
  server = t.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  gatewayUrl = `http://127.0.0.1:${addr.port}`;
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost|neon\.tech/);
});

beforeEach(() => {
  fakeChain = new FakeRuntimeChain();
  manager = new LeashRuntimeManager({
    pool: db.pool,
    hub: t.hub,
    broker: t.broker,
    chain: fakeChain,
    checkpointer,
    alerts: t.alerts,
    settings: {
      keyring: TEST_KEYRING,
      approvalTimeoutMs: 20_000,
      gatewayUrl,
      intervalMs: 3_600_000,
      defaultModel: 'test-model',
    },
  });
});

afterEach(async () => {
  for (const id of startedAgents.splice(0)) await manager.stop(id);
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await new Promise((resolve) => server.close(resolve));
  await db.drop();
});

async function seedTokenAgent(): Promise<string> {
  const gen = generateGatewayToken();
  const account = `0x${randomBytes(20).toString('hex')}`;
  fakeChain.balances.set(account.toLowerCase(), 10n ** 18n);
  fakeChain.balances.set(SESSION_ADDR.toLowerCase(), 10n ** 16n); // session funded ⇒ has-native
  return seedAgent(db.pool, {
    ownerAddr: OWNER,
    accountAddr: account,
    sessionKeyAddr: SESSION_ADDR,
    tokenId: gen.tokenId,
    tokenHash: await hashTokenSecret(gen.secret),
    sessionKeyEnc: encryptSecret(SESSION_PK, TEST_KEYRING),
    gatewayTokenEnc: encryptSecret(gen.token, TEST_KEYRING),
    goal: {
      type: 'treasury',
      beneficiary: BENEFICIARY,
      token: TOKEN,
      targetBalanceWei: (50n * CAP).toString(),
      topUpWei: (CAP / 2n).toString(),
      model: 'test-model',
    },
  });
}

function mockSend(): void {
  nock(UPSTREAM)
    .post('/v1/chat/completions')
    .reply(200, {
      id: 'c',
      choices: [
        { message: { role: 'assistant', content: JSON.stringify({ action: 'send', amountWei: (CAP / 2n).toString(), reason: 'token top-up' }) } },
      ],
      x_0g_trace: { provider: 'p', request_id: 'r', billing: {} },
    });
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('AQ-FND M-3 — token top-up act routing', () => {
  it('a spendable token routes to executeTokenTransfer (the self-funding act)', async () => {
    const id = await seedTokenAgent();
    fakeChain.tokenEnabled = true;
    fakeChain.tokenPayees = [BENEFICIARY.toLowerCase()];
    mockSend();
    await manager.start(id);
    startedAgents.push(id);
    await waitFor(() => fakeChain.tokenTransfers.length > 0);
    await manager.settle(id);
    expect(fakeChain.tokenTransfers).toHaveLength(1);
    expect(fakeChain.tokenTransfers[0]!.token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(fakeChain.tokenTransfers[0]!.to.toLowerCase()).toBe(BENEFICIARY.toLowerCase());
    expect(fakeChain.tokenTransfers[0]!.amountWei).toBe(CAP / 2n);
  });

  it('an UNGOVERNED token (policy disabled) → ONE owner ask + stand down, no token tx', async () => {
    const id = await seedTokenAgent();
    fakeChain.tokenEnabled = false; // never a budget → novel token
    mockSend();
    await manager.start(id);
    startedAgents.push(id);
    await waitFor(async () => (await listTraces(db.pool, id)).some((r) => r.kind === 'decision'));
    await manager.settle(id);
    // No doomed submit.
    expect(fakeChain.tokenTransfers).toHaveLength(0);
    // Exactly ONE capability_request ask.
    const { alerts } = await listAlerts(db.pool, OWNER, { kind: 'capability_request', agentId: id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.summary).toMatch(/has no budget — set one/i);
  });
});
