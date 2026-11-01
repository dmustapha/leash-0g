/**
 * AQ-FND M-3 — the self-funding gas ladder (gas-planner). Pins the D-4 ruling: every rung
 * pays out of the agent's own funds; the only non-self-funding outcome is an explicit ask.
 */
import { describe, it, expect } from 'vitest';
import { planGas, type GasRouteConfig, type GasSnapshot } from '../../src/chain/gas-planner.js';

const OG_TESTNET: GasRouteConfig = {
  gasFloorWei: 10n ** 15n, // 0.001
  refuelWei: 2n * 10n ** 15n,
  dexRouteAvailable: false, // P-GAS-3: no DEX on Galileo
};
const OG_MAINNET: GasRouteConfig = { ...OG_TESTNET, dexRouteAvailable: true }; // P-GAS-3: SwapRouter live

const TOKEN = '0x2222222222222222222222222222222222222222' as const;

function snap(over: Partial<GasSnapshot>): GasSnapshot {
  return {
    sessionNativeWei: 0n,
    accountNativeWei: 0n,
    spendableTokens: [],
    sessionKeyNativeAllowlisted: true,
    ...over,
  };
}

describe('planGas — the self-funding ladder (D-4: LEASH never sponsors)', () => {
  it('rung 1: funded key just acts', () => {
    expect(planGas(OG_TESTNET, snap({ sessionNativeWei: 10n ** 16n })).mode).toBe('has-native');
  });

  it('rung 2: account native refuels its own key through the governed wall', () => {
    expect(planGas(OG_TESTNET, snap({ accountNativeWei: 10n ** 18n })).mode).toBe('account-native');
  });

  it('rung 2 requires the owner-allowlisted native payee — else falls through', () => {
    const p = planGas(OG_TESTNET, snap({ accountNativeWei: 10n ** 18n, sessionKeyNativeAllowlisted: false }));
    expect(p.mode).toBe('ask-owner');
  });

  it('rung 3: token + DEX route → swap-to-gas (0G mainnet shape)', () => {
    const p = planGas(OG_MAINNET, snap({ spendableTokens: [{ token: TOKEN, balance: 5n * 10n ** 18n }] }));
    expect(p.mode).toBe('swap-to-gas');
  });

  it('rung 4: token but no DEX (Galileo) → ONE explicit ask, never a relayer-fronted tx or a silent stall', () => {
    const p = planGas(OG_TESTNET, snap({ spendableTokens: [{ token: TOKEN, balance: 5n * 10n ** 18n }] }));
    expect(p.mode).toBe('ask-owner');
  });

  it('there is no sponsored/relayer rung in the mode set (LEASH never fronts gas)', () => {
    const modes = new Set<string>();
    for (const cfg of [OG_TESTNET, OG_MAINNET]) {
      for (const tokens of [[], [{ token: TOKEN, balance: 1n }]]) {
        for (const native of [0n, 10n ** 16n]) {
          modes.add(planGas(cfg, snap({ sessionNativeWei: native, spendableTokens: tokens })).mode);
        }
      }
    }
    expect([...modes].sort()).toEqual(['ask-owner', 'has-native', 'swap-to-gas']);
  });

  it('zero-balance token does not count as spendable', () => {
    const p = planGas(OG_TESTNET, snap({ spendableTokens: [{ token: TOKEN, balance: 0n }] }));
    expect(p.mode).toBe('ask-owner');
  });
});
