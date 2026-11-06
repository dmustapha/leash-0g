/**
 * AQ-FND M-3 — the runtime adapters that feed the ratified self-funding gas ladder
 * (`planGas`, `backend/src/chain/gas-planner.ts`). `planGas` is pure; these build its
 * two inputs from LIVE server-read state (never model text):
 *
 *   buildGasRouteConfig(chainConfig)  — the per-chain route capabilities (pure).
 *   buildGasSnapshot(...)             — the live balances + spendability (I/O via chain).
 *
 * D-4 (LEASH never sponsors): the ladder either self-funds or asks the owner. A token
 * only counts as `spendable` when its on-chain V6 asset policy is ENABLED and the account
 * holds a balance. There is no relayer/sponsored rung.
 *
 * Increment 2 adds the MULTI-CHAIN side (`buildGasSurvey`, `loadGasRouteInputs`,
 * `planAgentGasRoute`, `describeGasAsk`) that feeds `planGasRoute`.
 */
import type { Address } from 'viem';
import type { Pool } from 'pg';
import type { ChainConfig } from '../chain/registry.js';
import {
  planGasRoute,
  type ChainGasView,
  type GasRoute,
  type GasRouteConfig,
  type GasSnapshot,
  type GasSurvey,
  type RouteChainCfg,
} from '../chain/gas-planner.js';
import { listChainDeployments } from '../store/chain-deployments.js';
import { cctpDomainOfChain } from '../governed-call/rail-domains.js';
import type { AgentGoal } from '../types.js';
import type { RuntimeChain } from './session-chain.js';

/** The ladder decision + its inputs, so the runtime can trace exactly what it read. */
export interface GasAssessment {
  cfg: GasRouteConfig;
  snap: GasSnapshot;
}

/**
 * Map a chain's static config onto the route capabilities the ladder reasons over.
 * Pure. `dexRouteAvailable` is derived from a configured canonical router (FALSE on
 * 0G Galileo testnet — P-GAS-3). `refuelWei` is the chain-priced session-key dust
 * (falls back to the global default when the chain does not override it).
 */
export function buildGasRouteConfig(chainConfig: ChainConfig, globalDustWei: bigint): GasRouteConfig {
  return {
    gasFloorWei: chainConfig.gasFloorWei,
    refuelWei: chainConfig.sessionGasDustWei ?? globalDustWei,
    dexRouteAvailable: Boolean(chainConfig.canonical?.router),
  };
}

/**
 * Read the live gas snapshot for a (session key, account) on the agent's chain. The
 * token leg is filtered to SPENDABLE tokens only (balance > 0 and an enabled asset policy);
 * a token with no enabled policy is NOT spendable, so the ladder falls to ask-owner.
 *
 * `getAssetPolicy` is optional on the chain surface (test fakes may omit it); when
 * absent, no token is spendable (fail-closed) and a zero-native agent asks the owner.
 */
export async function buildGasSnapshot(opts: {
  chain: RuntimeChain;
  accountAddr: string;
  sessionKeyAddr: string;
  /** The ERC-20 the goal spends (the top-up + repay token), or null for a native cycle. */
  token: string | null;
}): Promise<GasSnapshot> {
  const { chain, accountAddr, sessionKeyAddr, token } = opts;
  const [sessionNativeWei, accountNativeWei, sessionKeyNativeAllowlisted] = await Promise.all([
    chain.getBalance(sessionKeyAddr),
    chain.getBalance(accountAddr),
    isNativePayee(chain, accountAddr, sessionKeyAddr),
  ]);

  const spendableTokens: Array<{ token: Address; balance: bigint }> = [];
  if (token) {
    const spendable = await readSpendableToken(chain, accountAddr, token);
    if (spendable) spendableTokens.push(spendable);
  }

  return { sessionNativeWei, accountNativeWei, spendableTokens, sessionKeyNativeAllowlisted };
}

/**
 * The token's balance when it is SPENDABLE (balance > 0 ∧ policy enabled), else null.
 * Shared by the single-chain snapshot and the multi-chain survey.
 */
async function readSpendableToken(
  chain: RuntimeChain,
  accountAddr: string,
  token: string,
): Promise<{ token: Address; balance: bigint } | null> {
  if (!chain.getAssetPolicy) return null;
  const [balance, assetPolicy] = await Promise.all([
    chain.getErc20Balance(token, accountAddr),
    chain.getAssetPolicy(accountAddr, token, []),
  ]);
  if (balance > 0n && assetPolicy.enabled) {
    return { token: token.toLowerCase() as Address, balance };
  }
  return null;
}

/** Is the session key an allowlisted NATIVE payee (rung-2 precondition)? Fail-closed. */
async function isNativePayee(chain: RuntimeChain, accountAddr: string, sessionKeyAddr: string): Promise<boolean> {
  if (!chain.getAssetPolicy) return false;
  const nativePolicy = await chain.getAssetPolicy(
    accountAddr,
    '0x0000000000000000000000000000000000000000',
    [sessionKeyAddr],
  );
  return nativePolicy.allowedPayees.includes(sessionKeyAddr.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// AQ-FND M-3 (cross-chain gas routing, Increment 2): the multi-chain survey + planner inputs.
// Everything here is READ-ONLY and derived from config + chain reads + the owner-typed goal -
// nothing comes from model text.
// ---------------------------------------------------------------------------------------------

/**
 * ESTIMATES of the native gas one leg burns, in gas units. Increment 3 replaces these with
 * simulated figures once the swap/bridge executors exist; until then they only decide
 * "can the key afford this leg" for the route/ask, never the amount of any transaction.
 */
/**
 * The swap-to-gas route burns THREE swap-side txs on the target chain: approve (~50k) +
 * SwapRouter02 exactInputSingle (~200k) + WETH9 withdraw (~35k); 400k leaves headroom. The
 * fourth tx (the account->key refuel) is `REFUEL_LEG_GAS_UNITS`.
 */
const SWAP_LEG_GAS_UNITS = 400_000n;
const REFUEL_LEG_GAS_UNITS = 60_000n;
/** Gas units of ordinary actions the key should still be able to afford before it refills. */
const ACTION_HEADROOM_GAS_UNITS = 300_000n;
/** Gas-price floor (wei) used to turn the units into wei on chains whose own floor is lower. */
const MIN_ESTIMATE_GAS_PRICE_WEI = 1_000_000_000n; // 1 gwei
/** Per-chain read budget; a slower chain is reported `unknown`, never waited on. */
const SURVEY_CHAIN_TIMEOUT_MS = 8_000;

/**
 * Where the key counts as "low on gas" on a swap-to-gas chain: the swap+refuel legs it must still
 * afford PLUS headroom for ordinary actions. The planner's has-native test defaults to the chain's
 * gas-PRICE floor (0 on Base; 2 gwei on 0G) - orders of magnitude below what the legs cost - so
 * without this a swap-to-gas route is either never needed (floor 0) or never feasible (the key
 * must hold the leg gas to run it). Clamped to the refuel amount: a refuel that cannot lift the
 * key back above the trigger would re-run the swap every cycle. Only set when the chain carries
 * `gasSwap` config, so every other chain keeps its existing behaviour.
 */
function swapRefillTrigger(refuelWei: bigint, swapLegGasWei: bigint, refuelLegGasWei: bigint, gasPriceWei: bigint): bigint {
  const wanted = swapLegGasWei + refuelLegGasWei + ACTION_HEADROOM_GAS_UNITS * gasPriceWei;
  return wanted < refuelWei ? wanted : refuelWei;
}

/** buildGasRouteConfig + the per-leg gas estimates and DEX pair the route planner reads. */
export function buildRouteChainCfg(chainConfig: ChainConfig, globalDustWei: bigint): RouteChainCfg {
  const gasPriceWei =
    chainConfig.gasFloorWei > MIN_ESTIMATE_GAS_PRICE_WEI ? chainConfig.gasFloorWei : MIN_ESTIMATE_GAS_PRICE_WEI;
  const settlementToken = chainConfig.canonical?.settlementToken;
  const base = buildGasRouteConfig(chainConfig, globalDustWei);
  const swapLegGasWei = SWAP_LEG_GAS_UNITS * gasPriceWei;
  const refuelLegGasWei = REFUEL_LEG_GAS_UNITS * gasPriceWei;
  return {
    ...base,
    chainId: chainConfig.chainId,
    swapLegGasWei,
    refuelLegGasWei,
    ...(chainConfig.gasSwap
      ? { refillTriggerWei: swapRefillTrigger(base.refuelWei, swapLegGasWei, refuelLegGasWei, gasPriceWei) }
      : {}),
    dexPairs:
      chainConfig.canonical?.router && settlementToken ? [{ tokenIn: settlementToken.toLowerCase() as Address }] : [],
    ...(chainConfig.gasSwap
      ? {
          wrappedNative: chainConfig.gasSwap.wrappedNative.toLowerCase() as Address,
          dexFeeTier: chainConfig.gasSwap.dexFeeTier,
          gasSwapTokenAmount: chainConfig.gasSwap.tokenAmount,
        }
      : {}),
  };
}

function unknownView(chainId: number): ChainGasView {
  return {
    chainId,
    status: 'unknown',
    sessionNativeWei: 0n,
    accountNativeWei: 0n,
    spendableTokens: [],
    sessionKeyNativeAllowlisted: false,
  };
}

async function readChainView(opts: {
  chain: RuntimeChain;
  chainId: number;
  accountAddr: string;
  sessionKeyAddr: string;
  tokens: string[];
}): Promise<ChainGasView> {
  const { chain, chainId, accountAddr, sessionKeyAddr, tokens } = opts;
  const [sessionNativeWei, accountNativeWei, sessionKeyNativeAllowlisted, held] = await Promise.all([
    chain.getBalance(sessionKeyAddr),
    chain.getBalance(accountAddr),
    isNativePayee(chain, accountAddr, sessionKeyAddr),
    Promise.all(tokens.map((t) => readSpendableToken(chain, accountAddr, t))),
  ]);
  const spendableTokens = held.filter((h): h is { token: Address; balance: bigint } => h !== null);
  return { chainId, status: 'ok', sessionNativeWei, accountNativeWei, spendableTokens, sessionKeyNativeAllowlisted };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chain read timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Survey every chain the agent is deployed on. Each chain is read in its own try/catch under a
 * timeout: ANY failure ⇒ that chain is `unknown` (excluded from routing, NEVER treated as zero).
 * Never throws. The same account / session-key address is used on every chain (CREATE2).
 */
export async function buildGasSurvey(opts: {
  resolveChain: (chainId: number) => RuntimeChain;
  chainIds: number[];
  accountAddr: string;
  sessionKeyAddr: string;
  tokensByChain: Record<number, string[]>;
  /** per-chain read budget (ms); defaults to 8s. Exposed for tests. */
  timeoutMs?: number;
}): Promise<GasSurvey> {
  const views = await Promise.all(
    opts.chainIds.map(async (chainId): Promise<ChainGasView> => {
      try {
        const read = readChainView({
          chain: opts.resolveChain(chainId),
          chainId,
          accountAddr: opts.accountAddr,
          sessionKeyAddr: opts.sessionKeyAddr,
          tokens: opts.tokensByChain[chainId] ?? [],
        });
        return await withTimeout(read, opts.timeoutMs ?? SURVEY_CHAIN_TIMEOUT_MS);
      } catch {
        return unknownView(chainId);
      }
    }),
  );
  return { views };
}

/** The slice of the ChainRegistry the route planner needs (structural; tests fake it). */
export interface GasRouteRegistry {
  has(chainId: number): boolean;
  getChainConfig(chainId: number): ChainConfig;
  getSessionChain(chainId: number): RuntimeChain;
}

/** The owner-route surface (GET /gas-survey) reads the same registry slice. */
export type GasRouteSurface = GasRouteRegistry;

/** Everything the planner needs that can change between cycles (re-read every cycle). */
export interface GasRouteInputs {
  homeChainId: number;
  chainIds: number[];
  cfgByChain: Record<number, RouteChainCfg>;
  tokensByChain: Record<number, string[]>;
  /** CCTP bridge lanes (source chain -> the home chain, the source's settlement token). Empty unless the ops fill is enabled. */
  lanes: Array<{ from: number; to: number; token: Address }>;
}

/** The ERC-20 an owner-typed treasury goal is denominated in (lowercased), else null. */
export function goalTokenOf(goal: AgentGoal): string | null {
  if ((goal.type ?? 'treasury') !== 'treasury') return null;
  const token = (goal as { token?: string | undefined }).token;
  return token ? token.toLowerCase() : null;
}

/**
 * Resolve the survey scope: home ∪ onboarded deployments, restricted to registered chains,
 * re-read every cycle so a new onboarding takes effect without an agent restart.
 */
export async function loadGasRouteInputs(opts: {
  pool: Pool;
  registry: GasRouteRegistry;
  agentId: string;
  homeChainId: number;
  goalToken: string | null;
  globalDustWei: bigint;
  /** the ops key can complete a CCTP fill (a MessageTransmitter is configured): without it no burn may start */
  cctpFillEnabled?: boolean;
}): Promise<GasRouteInputs> {
  const { pool, registry, agentId, homeChainId, goalToken, globalDustWei } = opts;
  const deployments = await listChainDeployments(pool, agentId);
  const chainIds = [...new Set([homeChainId, ...deployments.map((d) => d.chainId)])].filter((id) => registry.has(id));
  const cfgByChain: Record<number, RouteChainCfg> = {};
  const tokensByChain: Record<number, string[]> = {};
  for (const id of chainIds) {
    const cfg = registry.getChainConfig(id);
    cfgByChain[id] = buildRouteChainCfg(cfg, globalDustWei);
    const settlement = cfg.canonical?.settlementToken;
    tokensByChain[id] = id === homeChainId ? homeSurveyTokens(goalToken, cfg.gasSwap ? settlement : undefined) : settlement ? [settlement] : [];
  }
  return { homeChainId, chainIds, cfgByChain, tokensByChain, lanes: opts.cctpFillEnabled ? cctpGasLanes(registry, chainIds, homeChainId) : [] };
}

/**
 * The tokens read on the HOME chain: the goal token, PLUS the chain's gas-swap input token when the chain
 * has `gasSwap` config. Without the second, an agent whose goal token is not the swap token (a NOVL goal on
 * Base, USDC swapped for gas) could never see the USDC it just bridged in, so swap-to-gas was never chosen
 * and the planner bridged AGAIN every cycle (live S4 run: a second burn 9 s after the first mint landed).
 */
export function homeSurveyTokens(goalToken: string | null, swapInputToken: string | undefined): string[] {
  const out: string[] = goalToken ? [goalToken] : [];
  if (swapInputToken && !out.some((t) => t.toLowerCase() === swapInputToken.toLowerCase())) out.push(swapInputToken);
  return out;
}

/**
 * CCTP lanes the gas route may bridge over: every surveyed non-home chain with a CCTP messenger, a
 * Circle domain and a settlement token (USDC), INTO the home chain (which must have a Circle domain too;
 * whether it has a DEX is the planner's call). Pure config - no chain reads.
 */
export function cctpGasLanes(
  registry: GasRouteRegistry,
  chainIds: number[],
  homeChainId: number,
): Array<{ from: number; to: number; token: Address }> {
  if (cctpDomainOfChain(homeChainId) === null) return [];
  const lanes: Array<{ from: number; to: number; token: Address }> = [];
  for (const id of chainIds) {
    if (id === homeChainId || cctpDomainOfChain(id) === null) continue;
    const cfg = registry.getChainConfig(id);
    const token = cfg.canonical?.settlementToken;
    if (cfg.cctpTokenMessenger && token) lanes.push({ from: id, to: homeChainId, token: token.toLowerCase() as Address });
  }
  return lanes;
}

/** Survey + plan in one read-only step (shared by the act loop and GET /gas-survey). */
export async function planAgentGasRoute(opts: {
  inputs: GasRouteInputs;
  resolveChain: (chainId: number) => RuntimeChain;
  accountAddr: string;
  sessionKeyAddr: string;
}): Promise<{ survey: GasSurvey; route: GasRoute }> {
  const { inputs } = opts;
  const survey = await buildGasSurvey({
    resolveChain: opts.resolveChain,
    chainIds: inputs.chainIds,
    accountAddr: opts.accountAddr,
    sessionKeyAddr: opts.sessionKeyAddr,
    tokensByChain: inputs.tokensByChain,
  });
  const route = planGasRoute(inputs.cfgByChain, survey, inputs.homeChainId, { lanes: inputs.lanes });
  return { survey, route };
}

/** "(>= 123 wei ...)" figures and bare chain ids in the planner's `missing` lines, made readable. */
function plainMissing(line: string, chainName: (chainId: number) => string): string {
  return line
    .replace(/\s*\(>= \d+ wei[^)]*\)/g, '')
    .replace(/chain (\d+)/g, (_m, id: string) => chainName(Number(id)));
}

/**
 * The owner-facing text of a route that cannot run on its own. Plain wording, chain names from
 * config, no raw wei: what was looked at, what could not be read, and what would unblock it.
 */
export function describeGasAsk(opts: {
  agentName: string;
  route: GasRoute;
  chainName: (chainId: number) => string;
}): string {
  const { agentName, route, chainName } = opts;
  const target = chainName(route.targetChainId);
  if (route.mode === 'swap-to-gas' || route.mode === 'bridge-then-swap') {
    const grants = [...new Set(route.legs.flatMap((l) => l.requiresGrants))];
    const how = route.mode === 'swap-to-gas' ? 'swap some of its tokens for gas' : 'bridge tokens in and swap them for gas';
    return `${agentName} could ${how} on ${target}, but that needs your approval first: ${grants.join(', ')}.`;
  }
  const looked = (route.ask?.surveyedChains ?? []).map(chainName);
  const unreadable = (route.ask?.unknownChains ?? []).map(chainName);
  const parts = [`${agentName} needs a little gas on ${target} to act and found no way to pay for it itself.`];
  if (looked.length > 0) parts.push(`Checked: ${looked.join(', ')}.`);
  if (unreadable.length > 0) parts.push(`Could not read: ${unreadable.join(', ')}.`);
  const missing = (route.ask?.missing ?? []).map((m) => plainMissing(m, chainName));
  if (missing.length > 0) parts.push(`What would unblock it: ${missing.join('; ')}.`);
  return parts.join(' ');
}
