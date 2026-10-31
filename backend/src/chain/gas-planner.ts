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
 *   4. `bootstrap-7702`  zero native anywhere but the account holds a token → the EIP-7702
 *                        GasRepayDelegate path (proven live on 0G, probe P-GAS-1): the ops
 *                        relayer submits the agent's voucher-signed batch as a type-4 tx and
 *                        is atomically repaid in the token THROUGH the governed wall.
 *   5. `ask-owner`       no self-funding path (e.g. token-only on a chain with no DEX and no
 *                        repayment token the owner has allowlisted) → ONE capability request
 *                        on the existing escalation rail ("I need a little native coin to get
 *                        started here"). The honest fallback — never a silent stall.
 *
 * This module is the DECISION layer (pure given a snapshot — unit-testable); executors for
 * rungs 2 and 4 live beside it. Rung 3's swap leg is a consumer of the governed-call rail
 * (A5 builds the actual tool); the planner only reports the route exists.
 */
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { encodeFunctionData, encodeAbiParameters, keccak256, parseAbi } from 'viem';
import type { DestGasPlan } from '../store/rail-transfers.js';

export type GasPlanMode = 'has-native' | 'account-native' | 'swap-to-gas' | 'bootstrap-7702' | 'ask-owner';

export interface GasRouteConfig {
  /** minimum session-key native balance considered "funded" (wei) */
  gasFloorWei: bigint;
  /** refuel amount for rung 2 (wei) — must be ≤ the native per-transfer cap */
  refuelWei: bigint;
  /** DEX token→native route exists on this chain (P-GAS-3; config, verified on-chain at wire) */
  dexRouteAvailable: boolean;
  /** GasRepayDelegate singleton on this chain (unset/0 ⇒ bootstrap unavailable) */
  gasRepayDelegate?: Address | undefined;
}

export interface GasSnapshot {
  sessionNativeWei: bigint;
  accountNativeWei: bigint;
  /** token balances the account holds with an ENABLED v6 asset policy + ops repayment payee */
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
  if (token && cfg.gasRepayDelegate && cfg.gasRepayDelegate !== '0x0000000000000000000000000000000000000000') {
    return { mode: 'bootstrap-7702', reason: `GasRepayDelegate bootstrap; repay in ${token.token}` };
  }
  return { mode: 'ask-owner', reason: 'no self-funding path on this chain — surface ONE ask, never stall silently' };
}

// ---------------------------------------------------------------------------------------------
// AQ-FND M-3 (cross-chain gas routing): the MULTI-CHAIN route planner. Pure + deterministic.
//
// PER-LEG PRINCIPLE: every leg runs on a chain and costs native gas on THAT chain (a CCIP bridge
// also pays its fee in native on the source). A route is therefore feasible only when each leg's
// chain can pay for that leg. An agent with zero native on every chain cannot route itself to gas:
// it can only ask the owner or (explicit owner opt-in) use the RELAYER bootstrap.
//
// Fixed preference order, first feasible wins (NOT cost optimisation):
//   has-native -> account-native -> swap-to-gas -> bridge-then-swap -> bootstrap-7702 (opt-in) -> ask-owner.
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
}

export interface GasRouteLeg {
  kind: 'refuel' | 'swap' | 'bridge' | 'bootstrap';
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
  /** owner opt-in (agents.allow_relayer_bootstrap): LEASH-ops may front gas, repaid in token */
  allowRelayerBootstrap: boolean;
  /** bridge lanes available between chains (from config); undefined/empty => the bridge rung is never chosen */
  lanes?: Array<{ from: number; to: number; token: Address }>;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const SWAP_GRANTS = ['swap rule on router', 'exact-amount approve', 'token budget'];

function hasDelegate(cfg: RouteChainCfg): boolean {
  return !!cfg.gasRepayDelegate && cfg.gasRepayDelegate !== ZERO_ADDR;
}

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
  opts: GasRouteOpts,
): NonNullable<GasRoute['ask']> {
  const id = view.chainId;
  const missing: string[] = [];
  if (!view.spendableTokens.some((t) => t.balance > 0n)) missing.push(`enable token policy / fund a spendable token on chain ${id}`);
  if (!cfg.dexRouteAvailable || (cfg.dexPairs?.length ?? 0) === 0) missing.push(`DEX route on chain ${id}`);
  if (view.accountNativeWei < cfg.refuelWei) missing.push(`account native funds on chain ${id} (>= ${cfg.refuelWei} wei)`);
  else if (!view.sessionKeyNativeAllowlisted) missing.push(`allowlist the session key as a native payee on chain ${id}`);
  missing.push(`gas on chain ${id} for the swap+refuel legs (>= ${cfg.swapLegGasWei + cfg.refuelLegGasWei} wei in the session key)`);
  if (!opts.allowRelayerBootstrap) missing.push('owner opt-in for relayer bootstrap');
  else if (!hasDelegate(cfg)) missing.push(`GasRepayDelegate on chain ${id}`);
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
  const token = view.spendableTokens.find((t) => t.balance > 0n);
  if (opts.allowRelayerBootstrap && hasDelegate(cfg) && token) {
    const leg: GasRouteLeg = { kind: 'bootstrap', chainId: targetChainId, token: token.token, gasOnChainId: targetChainId, gasNeededWei: 0n, requiresGrants: ['repayment payee for the relayer', 'token budget'] };
    return {
      mode: 'bootstrap-7702', targetChainId, legs: [leg],
      reason: `RELAYER-funded bootstrap (owner opt-in): LEASH-ops fronts the gas and is repaid in ${token.token} through the governed wall - not self-funded`,
    };
  }
  return {
    mode: 'ask-owner', targetChainId, legs: [],
    reason: 'no gas-feasible self-funding route - surface ONE ask, never stall silently',
    ask: buildAsk(cfg, view, survey, opts),
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
    case 'bootstrap-7702':
      return { destChainId, fundedWei: cfg.refuelWei.toString(), source: 'paymaster' };
    case 'ask-owner':
      return null; // G-9: no funded plan ⇒ the route is not enterable
  }
}

// ---------------------------------------------------------------------------------------------
// Rung-2 executor: the account refuels its own session key (a governed native transfer).
// ---------------------------------------------------------------------------------------------

const ACCOUNT_EXECUTE_ABI = parseAbi(['function execute(address to, uint256 value, bytes data)']);

export function buildAccountNativeRefuel(sessionKey: Address, refuelWei: bigint): { data: Hex } {
  return {
    data: encodeFunctionData({
      abi: ACCOUNT_EXECUTE_ABI,
      functionName: 'execute',
      args: [sessionKey, refuelWei, '0x'],
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Rung-4 executor: the EIP-7702 bootstrap (GasRepayDelegate.bootstrap voucher + type-4 submit).
// ---------------------------------------------------------------------------------------------

export interface BootstrapCall {
  target: Address;
  value: bigint;
  data: Hex;
}

const CALLS_TUPLE = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const;

const BOOTSTRAP_ABI = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function bootstrap(Call[] calls, uint256 nonce, uint256 deadline, address relayer, bytes sig)',
]);

/** The voucher digest the delegate verifies: keccak(chainid, eoa, nonce, deadline, relayer, keccak(calls)). */
export function voucherDigest(
  chainId: bigint,
  sessionEOA: Address,
  nonce: bigint,
  deadline: bigint,
  relayer: Address,
  calls: BootstrapCall[],
): Hex {
  const callsHash = keccak256(encodeAbiParameters(CALLS_TUPLE, [calls]));
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [chainId, sessionEOA, nonce, deadline, relayer, callsHash],
    ),
  );
}

/**
 * Run one zero-native bootstrap: the session wallet signs (a) the chain-pinned 7702
 * authorization to the immutable delegate and (b) the voucher over the batch; the OPS wallet
 * submits the type-4 tx and pays gas; the batch itself repays ops through the governed wall.
 * Returns the tx hash. The caller supplies `calls` whose LAST leg is the governed repayment.
 */
export async function executeBootstrap(opts: {
  publicClient: PublicClient;
  sessionWallet: WalletClient; // the agent's session key (signs; submits nothing)
  opsWallet: WalletClient; // the relayer (submits; made whole in-tx)
  delegate: Address;
  calls: BootstrapCall[];
  deadlineSeconds?: number;
}): Promise<{ txHash: Hex; nonce: bigint }> {
  const { publicClient, sessionWallet, opsWallet, delegate, calls } = opts;
  const sessionAccount = sessionWallet.account;
  const opsAccount = opsWallet.account;
  if (!sessionAccount || !opsAccount) throw new Error('gas-planner: wallets must carry accounts');
  const chainId = BigInt(await publicClient.getChainId());
  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 300));

  // (a) chain-pinned 7702 authorization — the delegation designator for the delegate
  const authorization = await sessionWallet.signAuthorization({
    account: sessionAccount,
    contractAddress: delegate,
    chainId: Number(chainId),
  });

  // (b) the voucher over the exact batch (eth_sign style, matches the delegate's digest)
  const digest = voucherDigest(chainId, sessionAccount.address, nonce, deadline, opsAccount.address, calls);
  const sig = await sessionWallet.signMessage({ account: sessionAccount, message: { raw: digest } });

  const data = encodeFunctionData({
    abi: BOOTSTRAP_ABI,
    functionName: 'bootstrap',
    args: [calls.map((c) => ({ target: c.target, value: c.value, data: c.data })), nonce, deadline, opsAccount.address, sig],
  });

  const txHash = await opsWallet.sendTransaction({
    account: opsAccount,
    chain: opsWallet.chain,
    to: sessionAccount.address, // the delegated EOA executes as itself
    data,
    authorizationList: [authorization],
    type: 'eip7702',
  });
  return { txHash, nonce };
}
