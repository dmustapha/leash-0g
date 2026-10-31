/**
 * AQ-FND M-3 — the runtime gas adapters (buildGasRouteConfig / buildGasSnapshot) feeding
 * the ratified planGas ladder. Pins the 0G-Galileo shape (no DEX, delegate set, zero
 * native): holding a spendable token → bootstrap-7702; no spendable token → ask-owner.
 */
import { describe, it, expect } from 'vitest';
import { buildGasRouteConfig, buildGasSnapshot } from '../../src/runtime/gas.js';
import { planGas } from '../../src/chain/gas-planner.js';
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
