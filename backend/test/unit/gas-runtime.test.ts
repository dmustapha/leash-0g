/**
 * AQ-FND M-3 — the runtime gas adapters (buildGasRouteConfig / buildGasSnapshot) feeding
 * the ratified planGas ladder. Pins the 0G-Galileo shape (no DEX, delegate set, zero
 * native): holding a spendable token → bootstrap-7702; no spendable token → ask-owner.
 */
import { describe, it, expect } from 'vitest';
import { buildGasRouteConfig, buildGasSnapshot, buildRouteChainCfg, buildGasSurvey, describeGasAsk } from '../../src/runtime/gas.js';
import { planGas, planGasRoute } from '../../src/chain/gas-planner.js';
import type { ChainConfig } from '../../src/chain/registry.js';
import type { RuntimeChain } from '../../src/runtime/session-chain.js';

const DELEGATE = '0xBcfA2994636D73Ea21625f83422a08B45e8c88C6';
const TOKEN = '0xec0259bc14580e81cfe87c0bdc39ca6b0bd97526';
const ACCOUNT = '0xe55296662581971d8cd7e26fc214b4a68d2c83ca';
const SESSION = '0xcb2a000000000000000000000000000000000001';
const OPS = '0xc211000000000000000000000000000000000002';
const GLOBAL_DUST = 2_000_000_000_000_000n; // 0.002 0G

// 0G Galileo testnet: no canonical router (no DEX) + a GasRepayDelegate singleton.
const GALILEO: ChainConfig = {
  chainId: 16602,
  name: '0G Galileo',
  rpcUrl: 'https://evmrpc-testnet.0g.ai',
  registryAddr: '0x' + '00'.repeat(20),
  accountVersion: 6,
  gasFloorWei: 2_000_000_000n,
  gasRepayDelegateAddr: DELEGATE,
};

/** A minimal chain fake: configurable balances + per-token policy/payees. */
function fakeChain(over: {
  sessionNative?: bigint;
  accountNative?: bigint;
  tokenBalance?: bigint;
  tokenEnabled?: boolean;
  tokenPayees?: string[]; // lowercased payees allowlisted for TOKEN
  nativePayees?: string[]; // lowercased payees allowlisted for native
}): RuntimeChain {
  const tokenPayees = (over.tokenPayees ?? []).map((p) => p.toLowerCase());
  const nativePayees = (over.nativePayees ?? []).map((p) => p.toLowerCase());
  return {
    async getBalance(addr: string): Promise<bigint> {
      if (addr.toLowerCase() === SESSION.toLowerCase()) return over.sessionNative ?? 0n;
      if (addr.toLowerCase() === ACCOUNT.toLowerCase()) return over.accountNative ?? 0n;
      return 0n;
    },
    async getErc20Balance(): Promise<bigint> {
      return over.tokenBalance ?? 0n;
    },
    async getAssetPolicy(_acct: string, token: string, payeeCandidates: string[]) {
      const isNative = token.toLowerCase() === '0x0000000000000000000000000000000000000000';
      const set = new Set(isNative ? nativePayees : tokenPayees);
      return {
        enabled: isNative ? true : (over.tokenEnabled ?? false),
        allowedPayees: payeeCandidates.map((p) => p.toLowerCase()).filter((p) => set.has(p)),
      };
    },
  } as unknown as RuntimeChain;
}

describe('buildGasRouteConfig — the 0G Galileo route shape', () => {
  it('no canonical router ⇒ dexRouteAvailable false (rung-3 off)', () => {
    const cfg = buildGasRouteConfig(GALILEO, GLOBAL_DUST);
    expect(cfg.dexRouteAvailable).toBe(false);
    expect(cfg.gasRepayDelegate).toBe(DELEGATE);
    expect(cfg.gasFloorWei).toBe(GALILEO.gasFloorWei);
    expect(cfg.refuelWei).toBe(GLOBAL_DUST);
  });
  it('a configured router ⇒ dexRouteAvailable true', () => {
    const cfg = buildGasRouteConfig({ ...GALILEO, canonical: { router: '0x' + 'ab'.repeat(20) } }, GLOBAL_DUST);
    expect(cfg.dexRouteAvailable).toBe(true);
  });
  it('a chain sessionGasDustWei overrides the global default', () => {
    const cfg = buildGasRouteConfig({ ...GALILEO, sessionGasDustWei: 42n }, GLOBAL_DUST);
    expect(cfg.refuelWei).toBe(42n);
  });
});

describe('buildGasSnapshot + planGas — the Galileo ladder outcome', () => {
  async function plan(chain: RuntimeChain, token: string | null) {
    const cfg = buildGasRouteConfig(GALILEO, GLOBAL_DUST);
    const snap = await buildGasSnapshot({ chain, accountAddr: ACCOUNT, sessionKeyAddr: SESSION, token, opsRelayerAddr: OPS });
    return planGas(cfg, snap);
  }

  it('zero native, holds a SPENDABLE token (enabled + relayer payee) ⇒ bootstrap-7702', async () => {
    const chain = fakeChain({ tokenBalance: 10n ** 18n, tokenEnabled: true, tokenPayees: [OPS] });
    expect((await plan(chain, TOKEN)).mode).toBe('bootstrap-7702');
  });

  it('zero native, NO token goal (native cycle) ⇒ ask-owner', async () => {
    const chain = fakeChain({});
    expect((await plan(chain, null)).mode).toBe('ask-owner');
  });

  it('holds the token but policy DISABLED ⇒ not spendable ⇒ ask-owner', async () => {
    const chain = fakeChain({ tokenBalance: 10n ** 18n, tokenEnabled: false, tokenPayees: [OPS] });
    expect((await plan(chain, TOKEN)).mode).toBe('ask-owner');
  });

  it('holds the token, enabled, but relayer NOT a payee ⇒ cannot repay ⇒ ask-owner (D-4)', async () => {
    const chain = fakeChain({ tokenBalance: 10n ** 18n, tokenEnabled: true, tokenPayees: [] });
    expect((await plan(chain, TOKEN)).mode).toBe('ask-owner');
  });

  it('enabled token, relayer NOT a payee ⇒ still SPENDABLE (swap route) but repayable=false', async () => {
    const chain = fakeChain({ tokenBalance: 10n ** 18n, tokenEnabled: true, tokenPayees: [] });
    const snap = await buildGasSnapshot({ chain, accountAddr: ACCOUNT, sessionKeyAddr: SESSION, token: TOKEN, opsRelayerAddr: OPS });
    expect(snap.spendableTokens).toEqual([{ token: TOKEN.toLowerCase(), balance: 10n ** 18n, repayable: false }]);
  });

  it('session key already funded ⇒ has-native (ladder short-circuits)', async () => {
    const chain = fakeChain({ sessionNative: 10n ** 16n, tokenBalance: 10n ** 18n, tokenEnabled: true, tokenPayees: [OPS] });
    expect((await plan(chain, TOKEN)).mode).toBe('has-native');
  });

  it('account holds native + session is a native payee ⇒ account-native refuel', async () => {
    const chain = fakeChain({ accountNative: 10n ** 18n, nativePayees: [SESSION] });
    expect((await plan(chain, null)).mode).toBe('account-native');
  });

  it('no getAssetPolicy on the chain ⇒ fail-closed, no spendable token ⇒ ask-owner', async () => {
    const chain = {
      async getBalance(): Promise<bigint> {
        return 0n;
      },
      async getErc20Balance(): Promise<bigint> {
        return 10n ** 18n;
      },
    } as unknown as RuntimeChain;
    const cfg = buildGasRouteConfig(GALILEO, GLOBAL_DUST);
    const snap = await buildGasSnapshot({ chain, accountAddr: ACCOUNT, sessionKeyAddr: SESSION, token: TOKEN, opsRelayerAddr: OPS });
    expect(snap.spendableTokens).toHaveLength(0);
    expect(snap.sessionKeyNativeAllowlisted).toBe(false);
    expect(planGas(cfg, snap).mode).toBe('ask-owner');
  });
});

describe('buildRouteChainCfg — AQ-FND M-3 inc-2 route config', () => {
  it('extends the route config with chainId, leg-gas estimates and (no router) no DEX pairs', () => {
    const cfg = buildRouteChainCfg(GALILEO, GLOBAL_DUST);
    expect(cfg.chainId).toBe(16602);
    expect(cfg.gasRepayDelegate).toBe(DELEGATE);
    // floor (2 gwei) is above the 1 gwei minimum ⇒ price = floor; estimates = units × price
    // 3 swap-side txs (approve + exactInputSingle + withdraw) => 400k units (inc-3a; was 250k for 1 swap)
    expect(cfg.swapLegGasWei).toBe(400_000n * 2_000_000_000n);
    expect(cfg.refuelLegGasWei).toBe(60_000n * 2_000_000_000n);
    expect(cfg.dexPairs).toEqual([]);
  });

  it('a gas floor below 1 gwei is priced at the 1 gwei minimum', () => {
    const cfg = buildRouteChainCfg({ ...GALILEO, gasFloorWei: 12_000_000n }, GLOBAL_DUST);
    expect(cfg.swapLegGasWei).toBe(400_000n * 1_000_000_000n);
    expect(cfg.refuelLegGasWei).toBe(60_000n * 1_000_000_000n);
  });

  it('router + settlementToken ⇒ one lowercased DEX pair; router alone ⇒ none', () => {
    const router = '0x' + 'ab'.repeat(20);
    const usdc = '0x' + 'CD'.repeat(20);
    const withPair = buildRouteChainCfg({ ...GALILEO, canonical: { router, settlementToken: usdc } }, GLOBAL_DUST);
    expect(withPair.dexRouteAvailable).toBe(true);
    expect(withPair.dexPairs).toEqual([{ tokenIn: usdc.toLowerCase() }]);
    expect(buildRouteChainCfg({ ...GALILEO, canonical: { router } }, GLOBAL_DUST).dexPairs).toEqual([]);
    expect(buildRouteChainCfg({ ...GALILEO, canonical: { settlementToken: usdc } }, GLOBAL_DUST).dexPairs).toEqual([]);
  });
});

describe('buildRouteChainCfg — inc-3a swap-to-gas executor constants', () => {
  const ROUTER = '0x' + 'ab'.repeat(20);
  const USDC = '0x' + 'cd'.repeat(20);
  const WETH = '0x' + 'EF'.repeat(20);
  const BASE: ChainConfig = {
    ...GALILEO,
    chainId: 84532,
    name: 'Base Sepolia',
    gasFloorWei: 0n,
    gasRepayDelegateAddr: undefined,
    canonical: { router: ROUTER, settlementToken: USDC },
    gasSwap: { wrappedNative: WETH, dexFeeTier: 3000, tokenAmount: 5_000_000n },
  };

  it('carries wrappedNative (lowercased), dexFeeTier and gasSwapTokenAmount from the chain config', () => {
    const cfg = buildRouteChainCfg(BASE, GLOBAL_DUST);
    expect(cfg.wrappedNative).toBe(WETH.toLowerCase());
    expect(cfg.dexFeeTier).toBe(3000);
    expect(cfg.gasSwapTokenAmount).toBe(5_000_000n);
    expect(cfg.dexPairs).toEqual([{ tokenIn: USDC }]);
  });

  it('a swap chain refills below (swap + refuel + headroom) legs, clamped to the refuel amount', () => {
    const cfg = buildRouteChainCfg(BASE, GLOBAL_DUST);
    const price = 1_000_000_000n; // floor 0 => 1 gwei minimum estimate price
    expect(cfg.refillTriggerWei).toBe((400_000n + 60_000n + 300_000n) * price);
    const clamped = buildRouteChainCfg({ ...BASE, sessionGasDustWei: 10n }, GLOBAL_DUST);
    expect(clamped.refillTriggerWei).toBe(10n);
  });

  it('no gasSwap config => no executor fields and no refill trigger (existing chains unchanged)', () => {
    const cfg = buildRouteChainCfg({ ...BASE, gasSwap: undefined }, GLOBAL_DUST);
    expect(cfg.wrappedNative).toBeUndefined();
    expect(cfg.refillTriggerWei).toBeUndefined();
  });

  it('planGasRoute still returns swap-to-gas with the raised leg-gas estimate', () => {
    const cfg = buildRouteChainCfg(BASE, GLOBAL_DUST);
    const sessionNativeWei = cfg.swapLegGasWei + cfg.refuelLegGasWei; // can afford the legs, below the trigger
    expect(sessionNativeWei).toBeLessThan(cfg.refillTriggerWei ?? 0n);
    const route = planGasRoute(
      { 84532: cfg },
      {
        views: [
          {
            chainId: 84532,
            status: 'ok',
            sessionNativeWei,
            accountNativeWei: 0n,
            spendableTokens: [{ token: USDC as `0x${string}`, balance: 9_000_000n }],
            sessionKeyNativeAllowlisted: true,
          },
        ],
      },
      84532,
      { allowRelayerBootstrap: false },
    );
    expect(route.mode).toBe('swap-to-gas');
    expect(route.legs.map((l) => l.kind)).toEqual(['swap', 'refuel']);
    expect(route.legs[0]?.gasNeededWei).toBe(400_000n * 1_000_000_000n);
  });
});

describe('buildGasSurvey — multi-chain, fail-closed per chain', () => {
  const TOKEN_B = '0x' + 'ab'.repeat(20);
  const survey = (
    resolve: (id: number) => RuntimeChain,
    chainIds: number[],
    tokensByChain: Record<number, string[]> = {},
    timeoutMs?: number,
  ) =>
    buildGasSurvey({
      resolveChain: resolve,
      chainIds,
      accountAddr: ACCOUNT,
      sessionKeyAddr: SESSION,
      opsRelayerAddr: OPS,
      tokensByChain,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  const rejecting = {
    async getBalance(): Promise<bigint> {
      throw new Error('rpc down');
    },
  } as unknown as RuntimeChain;

  it('reads each ok chain independently (native balances + spendable tokens)', async () => {
    const funded = fakeChain({ sessionNative: 5n, accountNative: 7n, tokenBalance: 9n, tokenEnabled: true, tokenPayees: [OPS] });
    const empty = fakeChain({});
    const out = await survey((id) => (id === 1 ? funded : empty), [1, 2], { 1: [TOKEN] });
    const [a, b] = out.views;
    expect(a).toMatchObject({ chainId: 1, status: 'ok', sessionNativeWei: 5n, accountNativeWei: 7n });
    expect(a!.spendableTokens).toEqual([{ token: TOKEN, balance: 9n, repayable: true }]);
    expect(b).toMatchObject({ chainId: 2, status: 'ok', sessionNativeWei: 0n });
    expect(b!.spendableTokens).toEqual([]);
  });

  it('lists multiple tokens; only the spendable ones appear', async () => {
    const chain = {
      ...fakeChain({ tokenBalance: 3n }),
      async getBalance(): Promise<bigint> {
        return 0n;
      },
      async getErc20Balance(): Promise<bigint> {
        return 3n;
      },
      async getAssetPolicy(_a: string, token: string, payees: string[]) {
        const spendable = token.toLowerCase() === TOKEN.toLowerCase();
        return { enabled: spendable, allowedPayees: spendable ? payees.map((p) => p.toLowerCase()) : [] };
      },
    } as unknown as RuntimeChain;
    const out = await survey(() => chain, [1], { 1: [TOKEN, TOKEN_B] });
    expect(out.views[0]!.spendableTokens.map((t) => t.token)).toEqual([TOKEN]);
  });

  it('a chain whose read throws is `unknown` (zeros), the others are still read; never throws', async () => {
    const ok = fakeChain({ sessionNative: 1n });
    const out = await survey((id) => (id === 1 ? rejecting : ok), [1, 2]);
    expect(out.views[0]).toMatchObject({ chainId: 1, status: 'unknown', sessionNativeWei: 0n, accountNativeWei: 0n, spendableTokens: [] });
    expect(out.views[1]).toMatchObject({ chainId: 2, status: 'ok', sessionNativeWei: 1n });
  });

  it('a resolver that throws (unregistered chain) is `unknown` too', async () => {
    const out = await survey(() => {
      throw new Error('unregistered');
    }, [9]);
    expect(out.views[0]).toMatchObject({ chainId: 9, status: 'unknown' });
  });

  it('a chain slower than the budget is `unknown` (timeout), not waited on', async () => {
    const slow = { getBalance: () => new Promise<bigint>(() => undefined) } as unknown as RuntimeChain;
    const out = await survey(() => slow, [1], {}, 20);
    expect(out.views[0]).toMatchObject({ chainId: 1, status: 'unknown' });
  });

  it('an unknown chain is excluded from routing: the planner never treats it as zero', async () => {
    const out = await survey(() => rejecting, [16602]);
    const route = planGasRoute({ 16602: buildRouteChainCfg(GALILEO, GLOBAL_DUST) }, out, 16602, { allowRelayerBootstrap: true });
    expect(route.mode).toBe('ask-owner');
    expect(route.ask?.unknownChains).toEqual([16602]);
  });
});

describe('describeGasAsk — plain wording, no raw wei', () => {
  const names: Record<number, string> = { 16602: '0G Galileo', 84532: 'Base Sepolia' };
  const chainName = (id: number) => names[id] ?? `chain ${id}`;

  it('ask-owner names the target, surveyed + unreadable chains and what would unblock', async () => {
    const broken = {
      async getBalance(): Promise<bigint> {
        throw new Error('x');
      },
    } as unknown as RuntimeChain;
    const out = await buildGasSurvey({
      resolveChain: (id) => (id === 84532 ? broken : fakeChain({})),
      chainIds: [16602, 84532],
      accountAddr: ACCOUNT,
      sessionKeyAddr: SESSION,
      opsRelayerAddr: OPS,
      tokensByChain: {},
    });
    const route = planGasRoute({ 16602: buildRouteChainCfg(GALILEO, GLOBAL_DUST) }, out, 16602, { allowRelayerBootstrap: false });
    const text = describeGasAsk({ agentName: 'Treasury', route, chainName });
    expect(text).toContain('Treasury needs a little gas on 0G Galileo');
    expect(text).toContain('Checked: 0G Galileo');
    expect(text).toContain('Could not read: Base Sepolia');
    expect(text).toContain('owner opt-in for relayer bootstrap');
    expect(text).not.toMatch(/\d+ wei/);
    expect(text).not.toContain('chain 16602');
  });

  it('swap-to-gas states the route and the grants it needs', () => {
    const text = describeGasAsk({
      agentName: 'Treasury',
      chainName,
      route: {
        mode: 'swap-to-gas',
        targetChainId: 84532,
        reason: 'x',
        legs: [{ kind: 'swap', chainId: 84532, gasOnChainId: 84532, gasNeededWei: 1n, requiresGrants: ['swap rule on router', 'exact-amount approve'] }],
      },
    });
    expect(text).toContain('swap some of its tokens for gas on Base Sepolia');
    expect(text).toContain('swap rule on router, exact-amount approve');
  });
});
