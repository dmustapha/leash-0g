import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { ruleKey, type CallRule, type GrantState } from '../../src/governed-call/index.js';
import type { ChainConfig } from '../../src/chain/registry.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';
import { executeGasBridge, precheckGasBridge, hasOpenBridgeInto, GasBridgeLegError, type GasBridgeEnv } from '../../src/runtime/gas-bridge.js';
import { getRailTransfer, listRailTransfersForAgent, markFilled } from '../../src/store/rail-transfers.js';

/**
 * AQ-FND M-3 inc-3b S3 — the bridge SOURCE leg through the governed wall. The fake source chain
 * ENFORCES the refusals the real USDC + TokenMessenger would: a burn without a sufficient allowance
 * reverts, a burn of more than the balance reverts, and approve/burn decode through the real ABI.
 */
const SRC = 421614; // Arb Sepolia (the agent holds USDC here)
const DEST = 84532; // Base Sepolia (needs gas; domain 6)
const AGENT = '5c3b7a10-0000-4000-8000-0000000000b1';
const ACCOUNT = '0x' + 'c2'.repeat(20);
const MESSENGER = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
const USDC = '0x' + 'cc'.repeat(20);
const CAP = 5_000_000n; // dest gasSwap.tokenAmount: 5 USDC
const SEL_APPROVE = toFunctionSelector('function approve(address,uint256)').toLowerCase();
const SEL_BURN = '0x8e0250ee';
const ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);

const SRC_CONFIG: ChainConfig = {
  chainId: SRC,
  name: 'Arbitrum Sepolia',
  rpcUrl: 'http://unused.invalid',
  registryAddr: '0x' + '00'.repeat(20),
  accountVersion: 6,
  gasFloorWei: 0n,
  bridgeAllowlist: [MESSENGER],
  cctpTokenMessenger: MESSENGER,
};

const rule = (target: string, selector: string, over: Partial<CallRule> = {}): CallRule => ({
  target, selector, recipientMode: 'self', spenderSet: [], perCallCap: '20000000', windowCapCall: '100000000', ...over,
});
const fullGrants = (): GrantState => ({
  rules: new Map([rule(USDC, SEL_APPROVE, { spenderSet: [MESSENGER] }), rule(MESSENGER, SEL_BURN)].map((r) => [ruleKey(r.target, r.selector), r])),
  budgets: new Map([[USDC, '100000000']]),
  allowlist: new Set<string>(),
});

class FakeSrcChain {
  balance = 12_000_000n; // 12 USDC
  allowance = 0n;
  grants: GrantState = fullGrants();
  calls: Array<{ target: string; data: string }> = [];
  burned: Array<{ amount: bigint; domain: number; recipient: string; caller: string }> = [];
  revertBurn = false;
  async getErc20Balance(): Promise<bigint> { return this.balance; }
  async readCallGrantState(): Promise<GrantState> { return this.grants; }
  async executeCall(input: { target: string; data: string }): Promise<{ txHash: string }> {
    const target = input.target.toLowerCase();
    this.calls.push({ target, data: input.data });
    if (target === USDC) {
      const { args } = decodeFunctionData({ abi: ABI, data: input.data as `0x${string}` });
      this.allowance = args[1] as bigint;
      return { txHash: '0x' + 'a1'.repeat(32) };
    }
    if (target === MESSENGER) {
      if (this.revertBurn) throw new Error('execution reverted');
      const { args } = decodeFunctionData({ abi: ABI, data: input.data as `0x${string}` });
      const [amount, domain, recipient, , caller] = args as unknown as [bigint, number, string, string, string];
      if (this.allowance < amount) throw new Error('ERC20: insufficient allowance');
      if (this.balance < amount) throw new Error('ERC20: burn amount exceeds balance');
      this.allowance -= amount;
      this.balance -= amount;
      this.burned.push({ amount, domain, recipient, caller });
      return { txHash: '0x' + 'b2'.repeat(32) };
    }
    throw new Error(`unexpected target ${target}`);
  }
}

describe('gas bridge executor (inc-3b S3)', () => {
  let db: TestDb;
  let chain: FakeSrcChain;
  let routable: GasBridgeEnv['assertRoutable'];
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db.drop(); });
  beforeEach(async () => {
    await db.pool.query('DELETE FROM rail_transfers');
    chain = new FakeSrcChain();
    routable = async () => ({ destinationChainId: DEST, verifiedAddr: ACCOUNT });
  });
  const env = (over: Partial<GasBridgeEnv> = {}): GasBridgeEnv => ({
    pool: db.pool, srcChain: chain as unknown as RuntimeChain, srcChainConfig: SRC_CONFIG, agentId: AGENT, accountAddr: ACCOUNT,
    destChainId: DEST, amountCap: CAP, fillGasWei: 150_000_000_000_000n, assertRoutable: routable, ...over,
  });

  it('happy path: 2 calls in order, exact calldata, rail row opened first and write-ahead with the burn hash', async () => {
    const pre = await precheckGasBridge(env(), USDC as `0x${string}`);
    expect(pre).toMatchObject({ ok: true, amount: CAP, domain: 6 });
    const out = await executeGasBridge(env(), { sessionPrivateKey: '0x01', token: USDC as `0x${string}`, amount: CAP });
    expect(chain.calls.map((c) => c.target)).toEqual([USDC, MESSENGER]);
    expect(chain.burned).toEqual([{ amount: CAP, domain: 6, recipient: `0x${'00'.repeat(12)}${ACCOUNT.slice(2)}`, caller: `0x${'00'.repeat(32)}` }]);
    expect(chain.balance).toBe(12_000_000n - CAP);
    const row = await getRailTransfer(db.pool, out.railId);
    expect(row).toMatchObject({ rail: 'cctp', status: 'initiated', srcChainId: SRC, destChainId: DEST, amountWei: CAP.toString(), srcTx: '0x' + 'b2'.repeat(32) });
    expect(row?.destGasPlan).toMatchObject({ destChainId: DEST, source: 'ops_fill', fundedWei: '150000000000000' });
  });

  it('while a transfer is open the planner is told not to start another; terminal frees it', async () => {
    const out = await executeGasBridge(env(), { sessionPrivateKey: '0x01', token: USDC as `0x${string}`, amount: CAP });
    expect(await hasOpenBridgeInto(db.pool, AGENT, DEST)).toBe(true);
    expect(await hasOpenBridgeInto(db.pool, AGENT, 11155111)).toBe(false); // a different destination
    await db.pool.query(`UPDATE rail_transfers SET status='attested' WHERE rail_id=$1`, [out.railId]);
    await db.pool.query(`UPDATE rail_transfers SET status='filling' WHERE rail_id=$1`, [out.railId]);
    await markFilled(db.pool, out.railId);
    expect(await hasOpenBridgeInto(db.pool, AGENT, DEST)).toBe(false);
  });

  it('caps the amount at the destination gas-swap figure; zero balance is unavailable', async () => {
    expect(await precheckGasBridge(env(), USDC as `0x${string}`)).toMatchObject({ ok: true, amount: CAP });
    chain.balance = 1_000_000n;
    expect(await precheckGasBridge(env(), USDC as `0x${string}`)).toMatchObject({ ok: true, amount: 1_000_000n });
    chain.balance = 0n;
    expect(await precheckGasBridge(env(), USDC as `0x${string}`)).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('a missing burn rule is ONE novel request for the burn leg; nothing is submitted, no row opened', async () => {
    chain.grants = { ...fullGrants(), rules: new Map([[ruleKey(USDC, SEL_APPROVE), rule(USDC, SEL_APPROVE, { spenderSet: [MESSENGER] })]]) };
    const pre = await precheckGasBridge(env(), USDC as `0x${string}`);
    expect(pre).toMatchObject({ ok: false, kind: 'l2', leg: 'burn' });
    expect(chain.calls).toHaveLength(0);
    expect(await listRailTransfersForAgent(db.pool, AGENT)).toHaveLength(0);
  });

  it('an approve rule that does not name the messenger as spender is novel at the approve leg', async () => {
    chain.grants = { ...fullGrants(), rules: new Map([
      [ruleKey(USDC, SEL_APPROVE), rule(USDC, SEL_APPROVE, { spenderSet: ['0x' + 'dd'.repeat(20)] })],
      [ruleKey(MESSENGER, SEL_BURN), rule(MESSENGER, SEL_BURN)],
    ]) };
    expect(await precheckGasBridge(env(), USDC as `0x${string}`)).toMatchObject({ ok: false, kind: 'l2', leg: 'approve' });
  });

  it('no CCTP messenger configured, or no Circle domain for the destination => unavailable', async () => {
    expect(await precheckGasBridge(env({ srcChainConfig: { ...SRC_CONFIG, cctpTokenMessenger: undefined } }), USDC as `0x${string}`)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(await precheckGasBridge(env({ destChainId: 16602 }), USDC as `0x${string}`)).toMatchObject({ ok: false, kind: 'unavailable' }); // 0G has no CCTP
  });

  it('the bridge-gate is a hard precondition: a refusal blocks everything', async () => {
    routable = async () => { throw new Error('bridge routing REFUSED (same_address_refused): mismatch'); };
    const pre = await precheckGasBridge(env(), USDC as `0x${string}`);
    expect(pre).toMatchObject({ ok: false, kind: 'forbidden', leg: 'burn' });
    expect((pre as { reason: string }).reason).toMatch(/same_address_refused/);
    expect(chain.calls).toHaveLength(0);
  });

  it('a reverting burn marks the row failed, burns nothing, and surfaces the leg', async () => {
    chain.revertBurn = true;
    const err = await executeGasBridge(env(), { sessionPrivateKey: '0x01', token: USDC as `0x${string}`, amount: CAP }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GasBridgeLegError);
    expect((err as GasBridgeLegError).leg).toBe('burn');
    const row = await getRailTransfer(db.pool, (err as GasBridgeLegError).railId);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row?.lastError).toMatch(/burn leg failed/);
    expect(chain.burned).toHaveLength(0);
    expect(chain.balance).toBe(12_000_000n);
    expect(await hasOpenBridgeInto(db.pool, AGENT, DEST)).toBe(false);
  });

  it('the fake enforces the real refusal: a burn bigger than the approved allowance reverts', async () => {
    chain.allowance = 1n;
    const { buildCctpBurnCalls } = await import('../../src/governed-call/index.js');
    const { burn } = buildCctpBurnCalls({ self: ACCOUNT as `0x${string}`, tokenMessenger: MESSENGER as `0x${string}`, burnToken: USDC as `0x${string}`, destinationDomain: 6, amount: CAP });
    await expect(chain.executeCall({ target: MESSENGER, data: burn.data })).rejects.toThrow(/insufficient allowance/);
  });
});
