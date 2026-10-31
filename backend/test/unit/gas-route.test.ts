/**
 * AQ-FND M-3 increment 1 - planGasRoute: the pure multi-chain gas route planner.
 * Pins the per-leg principle (every leg needs native gas on ITS chain), fail-closed
 * `unknown` chains, and that the relayer bootstrap is opt-in only.
 */
import { describe, it, expect } from 'vitest';
import {
  planGas,
  planGasRoute,
  type ChainGasView,
  type GasRouteOpts,
  type RouteChainCfg,
} from '../../src/chain/gas-planner.js';

const TOKEN = '0x2222222222222222222222222222222222222222' as const;
const DELEGATE = '0x1111111111111111111111111111111111111111' as const;
const BASE = 84532;
const OG = 16602;
const ETH = 11155111;

function cfg(chainId: number, over: Partial<RouteChainCfg> = {}): RouteChainCfg {
  return {
    chainId,
    gasFloorWei: 1000n,
    refuelWei: 2000n,
    dexRouteAvailable: true,
    gasRepayDelegate: DELEGATE,
    swapLegGasWei: 300n,
    refuelLegGasWei: 200n,
    dexPairs: [{ tokenIn: TOKEN }],
    ...over,
  };
}

function view(chainId: number, over: Partial<ChainGasView> = {}): ChainGasView {
  return {
    chainId,
    status: 'ok',
    sessionNativeWei: 0n,
    accountNativeWei: 0n,
    sessionKeyNativeAllowlisted: true,
    spendableTokens: [],
    ...over,
  };
}

const CFGS = { [BASE]: cfg(BASE), [OG]: cfg(OG), [ETH]: cfg(ETH) };
const NO_OPT: GasRouteOpts = { allowRelayerBootstrap: false };
const OPT_IN: GasRouteOpts = { allowRelayerBootstrap: true };

describe('planGasRoute - has-native', () => {
  it('refillTrigger defaults to the gas floor (identical to today\'s threshold)', () => {
    const at = planGasRoute(CFGS, { views: [view(BASE, { sessionNativeWei: 1000n })] }, BASE, NO_OPT);
    const below = planGasRoute(CFGS, { views: [view(BASE, { sessionNativeWei: 999n })] }, BASE, NO_OPT);
    expect(at.mode).toBe('has-native');
    expect(below.mode).not.toBe('has-native');
  });

  it('an explicit refillTrigger overrides the floor', () => {
    const cfgs = { [BASE]: cfg(BASE, { refillTriggerWei: 5000n }) };
    expect(planGasRoute(cfgs, { views: [view(BASE, { sessionNativeWei: 4999n })] }, BASE, NO_OPT).mode).not.toBe('has-native');
    expect(planGasRoute(cfgs, { views: [view(BASE, { sessionNativeWei: 5000n })] }, BASE, NO_OPT).mode).toBe('has-native');
  });

  it('agrees with planGas on the default threshold', () => {
    const snap = view(BASE, { sessionNativeWei: 1000n });
    expect(planGasRoute(CFGS, { views: [snap] }, BASE, NO_OPT).mode).toBe(planGas(CFGS[BASE], snap).mode);
  });
});

describe('planGasRoute - account-native', () => {
  it('chosen when the key can pay for the refuel leg itself', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE, { accountNativeWei: 5000n, sessionNativeWei: 200n })] }, BASE, NO_OPT);
    expect(r.mode).toBe('account-native');
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ kind: 'refuel', chainId: BASE, gasOnChainId: BASE, gasNeededWei: 200n });
  });

  it('NOT chosen when the key cannot pay the refuel leg gas (zero native)', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE, { accountNativeWei: 5000n })] }, BASE, NO_OPT);
    expect(r.mode).toBe('ask-owner');
  });

  it('NOT chosen when the session key is not an allowlisted payee', () => {
    const r = planGasRoute(
      CFGS,
      { views: [view(BASE, { accountNativeWei: 5000n, sessionNativeWei: 200n, sessionKeyNativeAllowlisted: false })] },
      BASE,
      NO_OPT,
    );
    expect(r.mode).not.toBe('account-native');
  });
});

describe('planGasRoute - swap-to-gas', () => {
  const held = [{ token: TOKEN, balance: 100n }];

  it('chosen when the key can pay swap + refuel gas', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE, { sessionNativeWei: 500n, spendableTokens: held })] }, BASE, NO_OPT);
    expect(r.mode).toBe('swap-to-gas');
    expect(r.legs.map((l) => l.kind)).toEqual(['swap', 'refuel']);
    expect(r.legs[0]!.requiresGrants).toEqual(['swap rule on router', 'exact-amount approve', 'token budget']);
  });

  it('499 wei (< swap+refuel) is not enough', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE, { sessionNativeWei: 499n, spendableTokens: held })] }, BASE, NO_OPT);
    expect(r.mode).toBe('ask-owner');
  });

  it('ZERO-native key + liquid DEX + token => ask-owner when opted out', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE, { spendableTokens: held })] }, BASE, NO_OPT);
    expect(r.mode).toBe('ask-owner');
    expect(r.ask?.missing).toContain(`gas on chain ${BASE} for the swap+refuel legs (>= 500 wei in the session key)`);
  });

  it('ZERO-native key + liquid DEX + token => bootstrap when opted in', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE, { spendableTokens: held })] }, BASE, OPT_IN);
    expect(r.mode).toBe('bootstrap-7702');
  });

  it('requires the token to be in dexPairs and the chain DEX flag', () => {
    const other = '0x3333333333333333333333333333333333333333' as const;
    const v = view(BASE, { sessionNativeWei: 900n, spendableTokens: [{ token: other, balance: 5n }] });
    expect(planGasRoute(CFGS, { views: [v] }, BASE, NO_OPT).mode).toBe('ask-owner');
    const noDex = { [BASE]: cfg(BASE, { dexRouteAvailable: false }) };
    expect(planGasRoute(noDex, { views: [view(BASE, { sessionNativeWei: 900n, spendableTokens: held })] }, BASE, NO_OPT).mode).toBe('ask-owner');
  });
});

describe('planGasRoute - unknown chains fail closed', () => {
  it('unknown target => ask-owner naming it', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE, { status: 'unknown' })] }, BASE, OPT_IN);
    expect(r.mode).toBe('ask-owner');
    expect(r.ask?.unknownChains).toEqual([BASE]);
    expect(r.reason).toContain(String(BASE));
  });

  it('missing target view => ask-owner', () => {
    const r = planGasRoute(CFGS, { views: [] }, BASE, NO_OPT);
    expect(r.mode).toBe('ask-owner');
    expect(r.ask?.unknownChains).toContain(BASE);
  });

  it('an unknown OTHER chain is excluded, not treated as zero, and never a bridge source', () => {
    const lanes = [{ from: OG, to: BASE, token: TOKEN }];
    const survey = {
      views: [
        view(BASE, { sessionNativeWei: 900n }),
        // looks rich but the read failed: must not be routable
        view(OG, { status: 'unknown', sessionNativeWei: 10n ** 18n, spendableTokens: [{ token: TOKEN, balance: 9n }] }),
      ],
    };
    const r = planGasRoute(CFGS, survey, BASE, { allowRelayerBootstrap: false, lanes });
    expect(r.mode).toBe('ask-owner');
    expect(r.ask?.unknownChains).toEqual([OG]);
    expect(r.ask?.surveyedChains).toEqual([BASE]);
  });
});

describe('planGasRoute - bootstrap-7702 is opt-in only and honest', () => {
  const v = view(BASE, { spendableTokens: [{ token: TOKEN, balance: 1n }] });

  it('never chosen when allowRelayerBootstrap=false', () => {
    expect(planGasRoute(CFGS, { views: [v] }, BASE, NO_OPT).mode).not.toBe('bootstrap-7702');
  });

  it('reason says relayer-funded, never self-funded', () => {
    const r = planGasRoute(CFGS, { views: [v] }, BASE, OPT_IN);
    expect(r.mode).toBe('bootstrap-7702');
    expect(r.reason).toMatch(/RELAYER-funded/);
    expect(r.reason).toMatch(/not self-funded/);
    expect(r.legs[0]).toMatchObject({ kind: 'bootstrap', chainId: BASE, gasNeededWei: 0n });
  });

  it('needs a delegate and a spendable token', () => {
    const noDelegate = { [BASE]: cfg(BASE, { gasRepayDelegate: undefined }) };
    expect(planGasRoute(noDelegate, { views: [v] }, BASE, OPT_IN).mode).toBe('ask-owner');
    expect(planGasRoute(CFGS, { views: [view(BASE)] }, BASE, OPT_IN).mode).toBe('ask-owner');
  });
});

describe('planGasRoute - ask-owner contents', () => {
  it('zero everything, opted out: precise missing list + surveyed chains', () => {
    const noDex = { ...CFGS, [BASE]: cfg(BASE, { dexRouteAvailable: false, dexPairs: [] }) };
    const r = planGasRoute(noDex, { views: [view(BASE), view(OG, { status: 'unknown' })] }, BASE, NO_OPT);
    expect(r.mode).toBe('ask-owner');
    expect(r.ask?.surveyedChains).toEqual([BASE]);
    expect(r.ask?.unknownChains).toEqual([OG]);
    expect(r.ask?.missing).toEqual([
      `enable token policy / fund a spendable token on chain ${BASE}`,
      `DEX route on chain ${BASE}`,
      `account native funds on chain ${BASE} (>= 2000 wei)`,
      `gas on chain ${BASE} for the swap+refuel legs (>= 500 wei in the session key)`,
      'owner opt-in for relayer bootstrap',
    ]);
  });

  it('opted in without a delegate asks for the delegate instead of the opt-in', () => {
    const noDelegate = { [BASE]: cfg(BASE, { gasRepayDelegate: undefined }) };
    const r = planGasRoute(noDelegate, { views: [view(BASE)] }, BASE, OPT_IN);
    expect(r.ask?.missing).toContain(`GasRepayDelegate on chain ${BASE}`);
    expect(r.ask?.missing).not.toContain('owner opt-in for relayer bootstrap');
  });
});

describe('planGasRoute - bridge-then-swap', () => {
  const lanes = [{ from: OG, to: BASE, token: TOKEN }];
  const src = view(OG, { sessionNativeWei: 400n, spendableTokens: [{ token: TOKEN, balance: 50n }] });

  it('never chosen without lanes (undefined or empty)', () => {
    const survey = { views: [view(BASE), src] };
    expect(planGasRoute(CFGS, survey, BASE, NO_OPT).mode).toBe('ask-owner');
    expect(planGasRoute(CFGS, survey, BASE, { allowRelayerBootstrap: false, lanes: [] }).mode).toBe('ask-owner');
  });

  it('chosen with a lane, source gas, and a target DEX; legs run on their own chains', () => {
    const r = planGasRoute(CFGS, { views: [view(BASE), src] }, BASE, { allowRelayerBootstrap: false, lanes });
    expect(r.mode).toBe('bridge-then-swap');
    expect(r.legs.map((l) => [l.kind, l.chainId, l.gasOnChainId])).toEqual([
      ['bridge', OG, BASE],
      ['swap', BASE, BASE],
    ]);
  });

  it('skipped when the source chain has no native for the bridge fee', () => {
    const broke = view(OG, { sessionNativeWei: 0n, spendableTokens: [{ token: TOKEN, balance: 50n }] });
    expect(planGasRoute(CFGS, { views: [view(BASE), broke] }, BASE, { allowRelayerBootstrap: false, lanes }).mode).toBe('ask-owner');
  });

  it('skipped when the target chain has no DEX', () => {
    const noDex = { ...CFGS, [BASE]: cfg(BASE, { dexRouteAvailable: false }) };
    expect(planGasRoute(noDex, { views: [view(BASE), src] }, BASE, { allowRelayerBootstrap: false, lanes }).mode).toBe('ask-owner');
  });

  it('skipped when the lane does not carry a token the source holds', () => {
    const other = '0x4444444444444444444444444444444444444444' as const;
    const wrong = [{ from: OG, to: BASE, token: other }];
    expect(planGasRoute(CFGS, { views: [view(BASE), src] }, BASE, { allowRelayerBootstrap: false, lanes: wrong }).mode).toBe('ask-owner');
  });
});

describe('planGasRoute - determinism', () => {
  it('same inputs produce identical output', () => {
    const survey = { views: [view(BASE, { spendableTokens: [{ token: TOKEN, balance: 3n }] }), view(OG, { status: 'unknown' })] };
    const a = planGasRoute(CFGS, survey, BASE, OPT_IN);
    const b = planGasRoute(CFGS, survey, BASE, OPT_IN);
    expect(b).toEqual(a);
  });
});
