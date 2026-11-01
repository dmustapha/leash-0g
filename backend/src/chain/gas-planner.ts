/**
 * AQ-FND M-3 — the SELF-FUNDING gas planner (D-4, Dami-ruled: LEASH NEVER sponsors).
 *
 * Decides, per (chain, agent), HOW the session key's next transaction gets paid for — always
 * out of the agent's own funds. The ladder (first match wins):
 *
 *   1. `has-native`      session EOA already holds ≥ the gas floor → just act.
 *   2. `account-native`  the ACCOUNT holds native → the account refuels its own key through
 *                        the governed wall (`execute(sessionKey, dust)`) — sessionKey must be
 *                        an owner-allowlisted native payee; the refuel is metered like any
 *                        other spend. The everyday self-funding workhorse.
 *   3. `swap-to-gas`     the account holds a token AND the chain has a configured DEX
 *                        token→native route (probe P-GAS-3: 0G MAINNET yes — SwapRouter
 *                        0x18cCa38E…; 0G Galileo TESTNET has no DEX) → governed SEL_SWAP leg
 *                        then rung 2. The route must be owner-granted (call rule + band).
 *   4. `ask-owner`       no self-funding path (e.g. token-only on a chain with no DEX) →
 *                        ONE capability request
 *                        on the existing escalation rail ("I need a little native coin to get
 *                        started here"). The honest fallback — never a silent stall.
 *
 * There is NO relayer/sponsored rung: LEASH never fronts gas (the EIP-7702 GasRepayDelegate
 * bootstrap was removed, Dami ruling 2026-11-01). This module is the DECISION layer (pure given
 * a snapshot — unit-testable); the rung-2 executor lives beside it. Rung 3's swap leg is a consumer of the governed-call rail
 * (A5 builds the actual tool); the planner only reports the route exists.
 */
import type { Address } from 'viem';
import type { DestGasPlan } from '../store/rail-transfers.js';

export type GasPlanMode = 'has-native' | 'account-native' | 'swap-to-gas' | 'ask-owner';

export interface GasRouteConfig {
  /** minimum session-key native balance considered "funded" (wei) */
  gasFloorWei: bigint;
  /** refuel amount for rung 2 (wei) — must be ≤ the native per-transfer cap */
  refuelWei: bigint;
  /** DEX token→native route exists on this chain (P-GAS-3; config, verified on-chain at wire) */
  dexRouteAvailable: boolean;
}

export interface GasSnapshot {
  sessionNativeWei: bigint;
  accountNativeWei: bigint;
  /** token balances the account holds with an ENABLED v6 asset policy */
  spendableTokens: Array<{ token: Address; balance: bigint }>;
  /** sessionKey is an allowlisted payee on the native asset (rung 2 precondition) */
  sessionKeyNativeAllowlisted: boolean;
}

export interface GasPlan {
  mode: GasPlanMode;
  reason: string;
}

/** The pure ladder — the unit the tests pin. */
export function planGas(cfg: GasRouteConfig, snap: GasSnapshot): GasPlan {
  if (snap.sessionNativeWei >= cfg.gasFloorWei) {
    return { mode: 'has-native', reason: `session key holds ${snap.sessionNativeWei} wei ≥ floor` };
  }
  if (snap.accountNativeWei >= cfg.refuelWei && snap.sessionKeyNativeAllowlisted) {
    return { mode: 'account-native', reason: 'account native funds refuel the key through the governed wall' };
  }
  const token = snap.spendableTokens.find((t) => t.balance > 0n);
  if (token && cfg.dexRouteAvailable) {
    return { mode: 'swap-to-gas', reason: `governed DEX leg can convert ${token.token} to native` };
  }
  return { mode: 'ask-owner', reason: 'no self-funding path on this chain — surface ONE ask, never stall silently' };
}

// ---------------------------------------------------------------------------------------------
// AQ-FND M-3 (cross-chain gas routing): the MULTI-CHAIN route planner. Pure + deterministic.
//
// PER-LEG PRINCIPLE: every leg runs on a chain and costs native gas on THAT chain (a CCIP bridge
// also pays its fee in native on the source). A route is therefore feasible only when each leg's
// chain can pay for that leg. An agent with zero native on every chain cannot route itself to gas:
// it can only ask the owner (LEASH never fronts gas).
//
// Fixed preference order, first feasible wins (NOT cost optimisation):
//   has-native -> account-native -> swap-to-gas -> bridge-then-swap -> ask-owner.
// An `unknown` chain (unreadable RPC) is excluded from routing - fail closed, never zero.
// `planGas` above is untouched; single-chain callers keep using it.
// ---------------------------------------------------------------------------------------------

export interface ChainGasView extends GasSnapshot {
  chainId: number;
  /** `unknown` = the chain's RPC could not be read; excluded from routing, never treated as zero. */
  status: 'ok' | 'unknown';
}

export interface GasSurvey {
  views: ChainGasView[];
}

export interface RouteChainCfg extends GasRouteConfig {
  chainId: number;
  /** below this the key needs gas; defaults to gasFloorWei (identical to the has-native threshold today) */
  refillTriggerWei?: bigint;
  /** native gas the swap leg costs on this chain */
  swapLegGasWei: bigint;
  /** native gas the follow-up refuel leg (account -> session key) costs on this chain */
  refuelLegGasWei: bigint;
  /** tokens with a verified DEX route to native on this chain */
  dexPairs?: Array<{ tokenIn: Address }>;
  /**
   * AQ-FND M-3 inc-3a: the swap-to-gas EXECUTOR constants (owner/operator config; the planner
   * itself never reads them - its ordering/semantics are unchanged). All three present =>
   * the runtime can execute a `swap-to-gas` route; any absent => it raises the honest ask.
   */
  wrappedNative?: Address | undefined;
  dexFeeTier?: number | undefined;
  /** token base units sold per gas swap (e.g. 5 USDC = 5_000_000); a config figure, never model-derived */
  gasSwapTokenAmount?: bigint | undefined;
}

export interface GasRouteLeg {
  kind: 'refuel' | 'swap' | 'bridge';
  /** the chain this leg executes on */
  chainId: number;
  token?: Address;
  /** the chain whose native gas this leg is meant to produce */
  gasOnChainId: number;
  /** native gas (wei) this leg consumes on its own chain */
  gasNeededWei: bigint;
  requiresGrants: string[];
}

export type GasRouteMode = GasPlanMode | 'bridge-then-swap';

export interface GasRoute {
  mode: GasRouteMode;
  targetChainId: number;
  legs: GasRouteLeg[];
  reason: string;
  ask?: { surveyedChains: number[]; unknownChains: number[]; missing: string[] };
}

export interface GasRouteOpts {
  /** bridge lanes available between chains (from config); undefined/empty => the bridge rung is never chosen */
  lanes?: Array<{ from: number; to: number; token: Address }>;
}

const SWAP_GRANTS = ['swap rule on router', 'exact-amount approve', 'token budget'];

function planBridgeThenSwap(
  cfgByChain: Record<number, RouteChainCfg>,
  okViews: ChainGasView[],
  target: ChainGasView,
  targetCfg: RouteChainCfg,
  lanes: NonNullable<GasRouteOpts['lanes']>,
): GasRoute | null {
  if (!targetCfg.dexRouteAvailable) return null;
  for (const lane of lanes) {
    if (lane.to !== target.chainId || lane.from === target.chainId) continue;
    const src = okViews.find((v) => v.chainId === lane.from);
    const srcCfg = cfgByChain[lane.from];
    if (!src || !srcCfg) continue;
    const held = src.spendableTokens.find((t) => t.token.toLowerCase() === lane.token.toLowerCase() && t.balance > 0n);
    // the bridge fee is paid in NATIVE on the source chain, so the source key must hold gas there
    const bridgeGas = srcCfg.refuelLegGasWei;
    if (!held || src.sessionNativeWei < bridgeGas) continue;
    return {
      mode: 'bridge-then-swap',
      targetChainId: target.chainId,
      legs: [
        { kind: 'bridge', chainId: src.chainId, token: lane.token, gasOnChainId: target.chainId, gasNeededWei: bridgeGas, requiresGrants: ['bridge rule on lane router', 'exact-amount approve', 'token budget'] },
        { kind: 'swap', chainId: target.chainId, token: lane.token, gasOnChainId: target.chainId, gasNeededWei: targetCfg.swapLegGasWei, requiresGrants: SWAP_GRANTS },
      ],
      reason: `bridge ${lane.token} from chain ${src.chainId} (fee paid in native on ${src.chainId}), then swap to native on chain ${target.chainId}`,
    };
  }
  return null;
}

function buildAsk(
  cfg: RouteChainCfg,
  view: ChainGasView,
  survey: GasSurvey,
): NonNullable<GasRoute['ask']> {
  const id = view.chainId;
  const missing: string[] = [];
  if (!view.spendableTokens.some((t) => t.balance > 0n)) missing.push(`enable token policy / fund a spendable token on chain ${id}`);
  if (!cfg.dexRouteAvailable || (cfg.dexPairs?.length ?? 0) === 0) missing.push(`DEX route on chain ${id}`);
  if (view.accountNativeWei < cfg.refuelWei) missing.push(`account native funds on chain ${id} (>= ${cfg.refuelWei} wei)`);
  else if (!view.sessionKeyNativeAllowlisted) missing.push(`allowlist the session key as a native payee on chain ${id}`);
  missing.push(`gas on chain ${id} for the swap+refuel legs (>= ${cfg.swapLegGasWei + cfg.refuelLegGasWei} wei in the session key)`);
  return {
    surveyedChains: survey.views.filter((v) => v.status === 'ok').map((v) => v.chainId),
    unknownChains: survey.views.filter((v) => v.status === 'unknown').map((v) => v.chainId),
    missing,
  };
}

function askUnreadableTarget(survey: GasSurvey, targetChainId: number, view: ChainGasView | undefined): GasRoute {
  const unknown = survey.views.filter((v) => v.status === 'unknown').map((v) => v.chainId);
  if (!view && !unknown.includes(targetChainId)) unknown.push(targetChainId);
  return {
    mode: 'ask-owner',
    targetChainId,
    legs: [],
    reason: `target chain ${targetChainId} is unreadable or not configured (unknown) - fail closed, no route`,
    ask: {
      surveyedChains: survey.views.filter((v) => v.status === 'ok').map((v) => v.chainId),
      unknownChains: unknown,
      missing: [`readable RPC and gas config for chain ${targetChainId}`],
    },
  };
}

export function planGasRoute(
  cfgByChain: Record<number, RouteChainCfg>,
  survey: GasSurvey,
  targetChainId: number,
  opts: GasRouteOpts,
): GasRoute {
  const view = survey.views.find((v) => v.chainId === targetChainId);
  const cfg = cfgByChain[targetChainId];
  if (!view || view.status === 'unknown' || !cfg) return askUnreadableTarget(survey, targetChainId, view);

  if (view.sessionNativeWei >= (cfg.refillTriggerWei ?? cfg.gasFloorWei)) {
    return { mode: 'has-native', targetChainId, legs: [], reason: `session key holds ${view.sessionNativeWei} wei on chain ${targetChainId}` };
  }
  const refuel: GasRouteLeg = {
    kind: 'refuel', chainId: targetChainId, gasOnChainId: targetChainId, gasNeededWei: cfg.refuelLegGasWei,
    requiresGrants: ['native payee allowlist for the session key', 'native per-transfer cap'],
  };
  if (view.accountNativeWei >= cfg.refuelWei && view.sessionKeyNativeAllowlisted && view.sessionNativeWei >= cfg.refuelLegGasWei) {
    return { mode: 'account-native', targetChainId, legs: [refuel], reason: 'account native funds refuel the key through the governed wall' };
  }
  const dexToken = view.spendableTokens.find((t) => t.balance > 0n && cfg.dexPairs?.some((p) => p.tokenIn.toLowerCase() === t.token.toLowerCase()));
  if (dexToken && cfg.dexRouteAvailable && view.sessionNativeWei >= cfg.swapLegGasWei + cfg.refuelLegGasWei) {
    const swap: GasRouteLeg = { kind: 'swap', chainId: targetChainId, token: dexToken.token, gasOnChainId: targetChainId, gasNeededWei: cfg.swapLegGasWei, requiresGrants: SWAP_GRANTS };
    return { mode: 'swap-to-gas', targetChainId, legs: [swap, refuel], reason: `governed DEX leg converts ${dexToken.token} to native on chain ${targetChainId}, then the account refuels the key` };
  }
  const okViews = survey.views.filter((v) => v.status === 'ok');
  const bridged = opts.lanes && opts.lanes.length > 0 ? planBridgeThenSwap(cfgByChain, okViews, view, cfg, opts.lanes) : null;
  if (bridged) return bridged;
  return {
    mode: 'ask-owner', targetChainId, legs: [],
    reason: 'no gas-feasible self-funding route - surface ONE ask, never stall silently',
    ask: buildAsk(cfg, view, survey),
  };
}

// ---------------------------------------------------------------------------------------------
// AQ-FND M-4 / G-9: the DESTINATION-gas plan a rail transfer must hold BEFORE it is
// enterable. `initiateRailTransfer` refuses a route without one (UnfundedRouteError) —
// this maps the self-funding ladder, evaluated against the DESTINATION chain's
// snapshot, onto that plan. `ask-owner` maps to null: the route is NOT enterable;
// the caller surfaces ONE capability ask instead of stranding funds mid-rail.
// ---------------------------------------------------------------------------------------------

export function planDestGas(cfg: GasRouteConfig, destSnap: GasSnapshot, destChainId: number): DestGasPlan | null {
  const plan = planGas(cfg, destSnap);
  switch (plan.mode) {
    case 'has-native':
      return { destChainId, fundedWei: destSnap.sessionNativeWei.toString(), source: 'prefunded' };
    case 'account-native':
    case 'swap-to-gas':
      // both secure destination gas through a governed refuel leg (swap lands native first)
      return { destChainId, fundedWei: cfg.refuelWei.toString(), source: 'refuel' };
    case 'ask-owner':
      return null; // G-9: no funded plan ⇒ the route is not enterable
  }
}
