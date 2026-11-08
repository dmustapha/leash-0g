import { formatAssetAmount } from '../asset/format.js';
import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Address } from 'viem';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalDecision } from '../approvals/broker.js';
import { createApproval } from '../store/approvals.js';
import { appendTrace } from '../trace/trace-store.js';
import { approvalEvent, reasoningEvent, traceEvent } from '../sse/events.js';
import type { Json } from '../crypto/canonical.js';
import type { AgentGoal, AgentRow, SentinelGoal, TraderGoal, TreasuryGoal } from '../types.js';
import { CoordinationError, type DelegationCoordinator } from '../coordination/coordinator.js';
import type { AlertService } from '../alerts/service.js';
import { BoundaryRegistry, policyFingerprint, DAMPABLE_ERRORS, type DampableError } from './boundary.js';
import { decodeLeashError } from '../chain/errors.js';
import { DEFAULT_CHAIN_CONFIG } from '../coordination/chain.js';
import { makeSenseDirection } from './sense-direction.js';
import { appendMemory } from '../store/agent-memory.js';
import { formatG, shortAddr, inMinutes, sanitizeAgentIntent } from '../util/format.js';
import type { DecodedLeashError } from '../types.js';
import type { RuntimeChain } from './session-chain.js';
import { buildGasRouteConfig, buildRouteChainCfg, describeGasAsk, planAgentGasRoute, type GasRouteInputs } from './gas.js';
import type { GasRoute } from '../chain/gas-planner.js';
import type { ChainConfig } from '../chain/registry.js';
import { loadGrantState } from './grant-state.js';
import { buildGovernedCall, BRIDGE_SELECTORS, SELECTORS } from '../governed-call/index.js';
import { SELECTOR_APPROVE } from '../governed-call/selectors.js';
import type { TradeFill } from '../governed-call/call-builder.js';
import { classifyIntendedCall } from '../gateway/call-gate.js';
import { executeGasSwap, GasSwapLegError, precheckGasSwap, gasSwapSetup, type GasSwapEnv } from './gas-swap.js';
import { executeGasBridge, precheckGasBridge, hasOpenBridgeInto, GasBridgeLegError, type GasBridgeEnv } from './gas-bridge.js';
import { raiseCapabilityRequest, type CapabilityDeps } from '../capabilities/service.js';
import { listGrants } from '../store/capabilities.js';
import { gateToolCall } from '../gateway/mcp/tool-gate.js';
import { guardToolResult, type ToolGrantState, type ToolRegistry } from '../tool-use/index.js';
import { raiseToolRequest, type ToolServiceDeps } from '../tool-use/tool-service.js';
import type { McpEgressClient } from '../gateway/mcp/governed-provider.js';
import {
  classifySigning,
  buildIntent,
  computeSigningRequestHash,
  type SigningGrantState,
  type SigningRegistry,
} from '../signing/index.js';
import { raiseSigningRequest, type SigningServiceDeps } from '../signing/signing-service.js';
import { recordSigningArm } from '../store/signing.js';
import {
  buildReasonRequest,
  completionChannels,
  rationaleAnchored,
  parseDecision,
  type AgentDecision,
  type CapabilityView,
  type InboundDelegationInput,
  type PolicySnapshot,
  type TraderHoldings,
} from './prompt.js';
import {
  capabilitiesKey,
  classifyOutcome,
  computeActionPossible,
  computeDelta,
  deriveCycleFlags,
  loadCycleMemory,
  snapshotsDiffer,
  type CycleMemory,
  type CycleRecord,
  type SenseSnapshot,
} from './cycle-memory.js';

/**
 * The agent graph (spec §3b): the Phase-1 treasury graph with one new
 * conditional edge and one new node — a CONDITIONAL refusal edge (Phase-0
 * gate — no unconditional gate→act) plus the Phase-2 `delegate` route:
 *
 *   sense → reason (via the LEASH gateway) → decide
 *     → [act | request-approval (interrupt) | delegate | stand-down] → record
 *   inbound: the manager feeds an activated delegation addressed to this
 *   agent into the cycle as LABELED UNTRUSTED input → normal reason/decide
 *
 * The decide node re-validates the LLM's decision against on-chain policy
 * deterministically — model output is untrusted input, the contract is the
 * hard boundary. Role wiring (treasury | sentinel | executor) lives ONLY in
 * this deterministic overlay (generality guard: the coordination layer never
 * sees the roles). All state is JSON-serializable for the Postgres
 * checkpointer.
 */

export type CycleOutcome =
  | { type: 'acted'; txHash: string; valueWei: string; approved?: boolean; callTarget?: string; token?: string; gasRung?: string; gasBought?: string }
  | { type: 'delegated'; delegationId: string }
  | { type: 'stood_down'; reason: string }
  | { type: 'denied'; reason: string }
  | { type: 'failed'; reason: string; decoded?: DecodedLeashError }
  | { type: 'tool_used'; toolId: string; isError?: boolean }
  // FP-3 governed signing: an L1 intent armed on-chain (session-key), or an L2 sensitive intent
  // quarantined to the owner JIT rail (armed only on consent — the arm submit path mirrors L1).
  | { type: 'signed'; digest: string; descriptorId: number }
  | { type: 'signing_requested'; descriptorId: number };

type Route = 'act' | 'token_act' | 'gas_swap' | 'gas_bridge' | 'approval' | 'delegate' | 'call' | 'tool_call' | 'sign' | 'stand_down';

/**
 * FP-3 — the runtime signing rail (OPTIONAL, mirror of `toolRail`). When wired, the decide node
 * routes a `sign` action through the SAME engine the owner routes use: classify against the owner's
 * signing grant-state; L1 → never-guess-money build + session-key `authorizeSigningIntent` arm +
 * record the arm; L2 (sensitive) → raise a quarantined JIT request + stand down (armed on consent);
 * forbidden / L3-widen → stand down, traced. Absent ⇒ a `sign` stands down (safe default-deny).
 */
export interface SigningRail {
  registry: SigningRegistry;
  /** live-read the owner's signing grant-state (rules mirror + on-chain signingEpoch). */
  loadGrant: (agentId: string) => Promise<SigningGrantState>;
  /**
   * Resolve the SERVER-held pins for a descriptor's NON-role, non-self leaves (never model text):
   * the permit `nonce` (read from chain), Permit2's `token` leaf (the granted budget token), etc.
   * A leaf with no pin stands the build down (`missing_pin`) — the engine never fabricates one.
   */
  resolvePins: (input: {
    agentId: string;
    descriptorId: number;
  }) => Promise<Record<string, string | number | bigint | boolean>>;
  service: SigningServiceDeps;
}

/**
 * SF-3 — the runtime tool rail (OPTIONAL, mirror of the `capabilities` dep). When
 * wired, the decide node routes a `tool_call` action through the SAME tool-gate
 * the MCP gateway uses: L1 executes via the egress client + records a `tool_used`
 * outcome (symmetric with `callAct` recording a txHash); L2 raises a JIT request
 * and stands down (owner grants before it can ever run); forbidden stands down.
 * Absent ⇒ a `tool_call` simply stands down, traced (safe default-deny).
 */
export interface ToolRail {
  registry: ToolRegistry;
  loadGrant: (agentId: string) => Promise<ToolGrantState>;
  service: ToolServiceDeps;
  executor: McpEgressClient;
  maxIoBytes?: number | undefined;
}

const TreasuryState = Annotation.Root({
  /** Set by the manager when this cycle processes an inbound delegation (spec §3b). */
  inboundDelegation: Annotation<InboundDelegationInput | null>,
  beneficiaryBalanceWei: Annotation<string>,
  /** AQ-FND M-3: the beneficiary's balance in the goal's ERC-20 (token goals only; '0' for native). */
  beneficiaryTokenBalanceWei: Annotation<string>,
  /** C9: the ACCOUNT's balance in the goal's ERC-20 (token goals only; '0' for native). */
  accountTokenBalanceWei: Annotation<string>,
  accountBalanceWei: Annotation<string>,
  /** Transfer target this cycle: goal beneficiary, or the inbound request's. */
  effectiveBeneficiary: Annotation<string>,
  policy: Annotation<PolicySnapshot>,
  /** Stage D (D-10): the governed calls this agent may make this cycle (serializable). */
  capabilities: Annotation<CapabilityView[]>,
  /** FR3 (F-8): the trader role's sensed token holdings (null for every other role). */
  holdings: Annotation<TraderHoldings | null>,
  /** D-3 (token half): server-read decimals/symbol per goal token, so DISPLAY labels the real asset. */
  tokenMeta: Annotation<{ hold?: { symbol: string; decimals: number }; spend?: { symbol: string; decimals: number } }>,
  /**
   * FR3b: the band-feed price (18dp decimal string) sensed for the trader's swap
   * rule this cycle, or null (no band / unreadable). Read at SENSE time so the
   * wall re-checks a price that is one reasoning-step old — exactly the gap the
   * on-chain band exists to close (a feed move mid-cycle reverts PremiumBreach).
   * Never shown to the model; only the minOut derivation consumes it.
   */
  bandPrice18: Annotation<string | null>,
  reasoning: Annotation<string>,
  /**
   * AQ-A0-Q2VIS D-2: the model's DELIBERATION (`reasoning_content`), kept separate from
   * `reasoning` (which is the decision channel `parseDecision` runs on). This is the Q2 signal —
   * it was generated and billed on every cycle already and then discarded (S-1/S-2).
   */
  deliberation: Annotation<string>,
  /** D-2/G-6: which channel the decision came from. `'scavenge'` = the truncation rescue fired. */
  decisionSource: Annotation<'content' | 'scavenge' | 'empty'>,
  /** D-6/G-2: `finish_reason` of the reasoning call — `'length'` is the degenerate signature. */
  finishReason: Annotation<string | null>,
  /** D-6: `"action":` restatement count inside the deliberation (severity, not a classifier). */
  deliberationLoops: Annotation<number>,
  /** AQ-A1 D-1: the server-composed cross-cycle carry fed into THIS cycle's prompt (null = cold). */
  cycleMemory: Annotation<CycleMemory | null>,
  /** AQ-A1 D-2: was a legitimate action available this cycle (per-role predicate)? Metric denominator. */
  actionPossible: Annotation<boolean>,
  /** AQ-A1 D-2: did anything decision-relevant move since the previous cycle? Metric gate. */
  observedChange: Annotation<boolean>,
  /** AQ-A1 D-1/D-2: the compact sensed snapshot to PERSIST on this cycle's trace record (the next cycle diffs it). */
  senseSnapshot: Annotation<SenseSnapshot | null>,
  /** AQ-A1 D-3: usage.prompt_tokens of this cycle's reason call (the per-cycle input-budget instrument). */
  promptTokens: Annotation<number | null>,
  decision: Annotation<AgentDecision>,
  route: Annotation<Route>,
  /** Stage D (D-10): the resolved governed-call `executeCall` args for the `call` route. */
  callTarget: Annotation<string>,
  callData: Annotation<string>,
  callValue: Annotation<string>,
  /** AQ-FND M-3: the resolved token top-up for the `token_act` route (decide → tokenAct). */
  tokenActToken: Annotation<string>,
  tokenActAmountWei: Annotation<string>,
  /** AQ-FND M-3: the gas rung the ladder picked this cycle ('has-native' | 'account-native'). */
  tokenActGasRung: Annotation<string>,
  /** AQ-FND M-3 inc-3a: the `gas_swap` route's resolved sale (decide -> gasSwapAct). */
  gasSwapToken: Annotation<string>,
  gasSwapAmountIn: Annotation<string>,
  /** AQ-FND M-3 inc-3b: the `gas_bridge` route's resolved burn (decide -> gasBridgeAct). */
  gasBridgeToken: Annotation<string>,
  gasBridgeAmount: Annotation<string>,
  gasBridgeSrcChain: Annotation<number>,
  /** SF-3: the resolved L1 tool call for the `tool_call` route (egress leg). */
  toolName: Annotation<string>,
  toolEndpoint: Annotation<string>,
  toolArgs: Annotation<Json>,
  toolIdResolved: Annotation<string>,
  /** FP-3: the resolved L1 signing intent for the `sign` route (session-key arm leg). */
  signDescriptorId: Annotation<number>,
  signFields: Annotation<string[]>,
  signDigest: Annotation<string>,
  signSpender: Annotation<string>,
  signAmountWei: Annotation<string>,
  signDeadlineSec: Annotation<number>,
  /** Verbatim markFailed reason for a rejected inbound envelope (spec §3b). */
  inboundReject: Annotation<string>,
  approvalId: Annotation<string>,
  outcome: Annotation<CycleOutcome>,
});

type State = typeof TreasuryState.State;

export interface TreasuryGraphDeps {
  pool: Pool;
  hub: SseHub;
  /** Phase-3 alert engine (optional: coordination-free test setups omit it). */
  alerts?: AlertService | undefined;
  /** P3C-6(iii) futile-retry damping registry (shared across cycles by the manager). */
  boundaries?: BoundaryRegistry | undefined;
  /** For the approval-card deadline copy (falls back to a generic line when absent). */
  approvalTimeoutMs?: number | undefined;
  chain: RuntimeChain;
  /**
   * Stage D (D-10): the capability service for the L2 JIT rail. When a governed
   * `call` intent is NOVEL the decide node raises a quarantined capability request
   * here instead of a doomed on-chain submit (P3C-6). Absent in coordination-free
   * / alert-free test setups — a novel call then simply stands down, traced.
   */
  capabilities?: CapabilityDeps | undefined;
  /** SF-3 — the governed tool-use rail (optional; absent ⇒ tool_call stands down). */
  toolRail?: ToolRail | undefined;
  /** FP-3 — the governed signing rail (optional; absent ⇒ sign stands down). */
  signingRail?: SigningRail | undefined;
  /**
   * SE-8 — the governed-bridging lane. `targets` = the chain's bridge allowlist
   * (classify enforcement, carry #2); `assertRoutable` = the HARD pre-routing
   * same-address gate (carry #1: `ChainRegistry.assertSameAddress` on home +
   * destination, bound to the persisted account). Absent = no bridging possible
   * on this runtime (fail-closed: a bridge call classifies forbidden without
   * `targets`, and even an L1 one stands down without the gate).
   */
  bridge?:
    | {
        targets: Set<string>;
        assertRoutable: (
          bridgeTarget: string,
          // AQ-FND M-4: multi-domain rails (CCTP/CCIP) resolve their far chain
          // from the DECODED call — threaded through to the bridge-gate.
          decoded?: import('../governed-call/types.js').DecodedCall,
          /** inc-3b: the chain the bridge call is made on (default: the agent's home chain) */
          srcChainId?: number,
        ) => Promise<{ destinationChainId: number; verifiedAddr: string }>;
      }
    | undefined;
  /**
   * AQ-FND M-3: the agent's chain config — the self-funding gas ladder reads
   * `gasFloorWei` / `sessionGasDustWei` / `canonical.router`
   * from here (`buildGasRouteConfig`). Optional: absent ⇒ no gas ladder engages and
   * the token top-up proceeds exactly as the native path (no regression). The global
   * dust default is carried alongside for chains that do not override it.
   */
  gasConfig?: { chainConfig: ChainConfig; globalDustWei: bigint } | undefined;
  /**
   * AQ-FND M-3 inc-2: the MULTI-CHAIN gas-route inputs. `load()` re-reads (every cycle) the
   * chains the agent is deployed on, so a new
   * onboarding takes effect without a restart. Absent (single-chain test setups) ⇒ the route
   * is planned over the home chain only, from `gasConfig` + `chain`.
   */
  gasRoute?:
    | {
        resolveChain: (chainId: number) => RuntimeChain;
        /** human label for a chain id (config name) used in owner-facing ask text */
        chainName: (chainId: number) => string;
        /** a surveyed chain's config (the bridge leg reads its CCTP messenger / allowlist) */
        chainConfigOf?: (chainId: number) => ChainConfig;
        load: (homeGoalToken: string | null) => Promise<GasRouteInputs>;
      }
    | undefined;
  gatewayUrl: string;
  defaultModel: string;
  /**
   * Late-bound (the manager is constructed before the coordinator): resolved
   * per use, never captured. Absent/null only in coordination-free setups —
   * the delegate route then fails traced instead of crashing.
   */
  getCoordinator?: () => DelegationCoordinator | null;
  fetchFn?: typeof fetch;
}

export interface TreasuryAgentContext {
  agentId: string;
  accountAddr: string;
  goal: AgentGoal;
  /** Full row — issueDelegation needs the issuer row (id + name for the approval card). */
  agentRow: AgentRow;
  /** Scoped session key — the ONLY signing material the runtime holds. */
  sessionPrivateKey: string;
  gatewayToken: string;
}

/**
 * The ONLY payload shape the specimen executor interprets (spec §3b
 * generality guard: everything else is handled generically as 'unsupported
 * kind'). Inbound payloads are UNTRUSTED — strict-validated before any use.
 */
const transferRequestSchema = z.object({
  beneficiary: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountWei: z.string().regex(/^\d{1,30}$/),
  rationale: z.string().max(2000).optional(),
});

type TransferRequest = z.infer<typeof transferRequestSchema>;

/**
 * Phase 5.6 (D-11/§3b): the inbound chain-hop envelope, interpreted ONLY here in
 * the runtime graph (opaque to the coordination layer). Strict-Zod — a
 * hostile/oversized/type-smuggled payload is rejected → markFailed, the chain
 * terminates. `upstreamOutput` is LABELED-UNTRUSTED input, NEVER authority: the
 * downstream re-reasons under its OWN goal/policy and its action target comes
 * from its OWN server link-state (D-3), never from this payload.
 */
const chainHandoffSchema = z
  .object({
    chainId: z.string().regex(/^[0-9a-f-]{36}$/i),
    // Coarse defensive bound tied to the depth cap (a hopIndex is 0-based, so a
    // valid plan reaches maxDepth-1); the chain projection's next_hop is the real
    // gate. Kept ≥ the cap so config never rejects a legitimate final hop.
    hopIndex: z.number().int().min(0).max(DEFAULT_CHAIN_CONFIG.maxDepth),
    ownerDirectedIntent: z.string().max(2000),
    upstreamOutput: z.unknown(),
  })
  .strip();

type ChainHandoff = z.infer<typeof chainHandoffSchema>;

/**
 * Deterministic per-cycle classification (pure — safe to call from several
 * nodes). Roles interpret the cycle (spec §3b):
 * - autonomous: treasury (Phase-1 unchanged) or sentinel (delegates).
 * - executor_idle: executor with no inbound — autonomous decide DISABLED
 *   (closes the double-actor duplicate-spend hazard, spec §1a).
 * - inbound_transfer: executor processing a valid 'transfer.request'.
 * - inbound_reject: any other inbound (unknown kind anywhere, malformed
 *   payload, or a non-executor receiver) → markFailed with the verbatim
 *   reason, no reasoning, no act.
 */
type CycleMode =
  | { mode: 'autonomous'; goal: TreasuryGoal | SentinelGoal | TraderGoal }
  | { mode: 'executor_idle' }
  | { mode: 'inbound_transfer'; request: TransferRequest }
  // Phase 5.6: a chain hop the downstream re-reasons on under its OWN goal — the
  // handoff is context (labeled-untrusted), the goal is authority (F4/F5, D-3).
  | { mode: 'inbound_chain'; goal: TreasuryGoal | SentinelGoal; handoff: ChainHandoff }
  | { mode: 'inbound_reject'; reason: 'unsupported kind' | 'malformed payload' };

function classifyCycle(goal: AgentGoal, inbound: InboundDelegationInput | null | undefined): CycleMode {
  // Phase-4 job roles (requester/provider/evaluator) run in their OWN runtime
  // (jobs/*), never through this treasury/transfer graph — guard defensively.
  const role = goal.type ?? 'treasury';
  const isLegacyAutonomous = role === 'treasury' || role === 'sentinel';
  if (!inbound) {
    if (role === 'executor') return { mode: 'executor_idle' };
    // FR3 (F-8): the trader is autonomous like treasury — its decide loop is the
    // first surface a granted swap capability can ADVANCE (it never sends native).
    if (isLegacyAutonomous || role === 'trader') {
      return { mode: 'autonomous', goal: goal as TreasuryGoal | SentinelGoal | TraderGoal };
    }
    return { mode: 'inbound_reject', reason: 'unsupported kind' };
  }
  // Phase 5.6 chain hop: a goal-bearing (treasury/sentinel) downstream
  // re-reasons under its OWN goal/policy, informed by the labeled-untrusted
  // handoff. A malformed/oversized payload is rejected (markFailed → chain
  // terminates). A role with no autonomous action surface (executor) can't
  // consume a handoff → unsupported (the chain terminates, traced).
  if (inbound.kind === 'chain.handoff') {
    if (!isLegacyAutonomous) return { mode: 'inbound_reject', reason: 'unsupported kind' };
    const parsed = chainHandoffSchema.safeParse(inbound.payload);
    if (!parsed.success) return { mode: 'inbound_reject', reason: 'malformed payload' };
    return { mode: 'inbound_chain', goal: goal as TreasuryGoal | SentinelGoal, handoff: parsed.data };
  }
  // Only the specimen executor interprets 'transfer.request' (spec §3b) —
  // every other (role, kind) combination is generically unsupported.
  if (goal.type !== 'executor' || inbound.kind !== 'transfer.request') {
    return { mode: 'inbound_reject', reason: 'unsupported kind' };
  }
  const parsed = transferRequestSchema.safeParse(inbound.payload);
  if (!parsed.success) return { mode: 'inbound_reject', reason: 'malformed payload' };
  return { mode: 'inbound_transfer', request: parsed.data };
}

/** The autonomous goal a cycle re-reasons under (Phase 5.6 folds inbound_chain in). */
function autonomousGoalOf(mode: CycleMode): TreasuryGoal | SentinelGoal | TraderGoal | null {
  if (mode.mode === 'autonomous' || mode.mode === 'inbound_chain') return mode.goal;
  return null;
}

/**
 * AQ-FND M-3: the ERC-20 a treasury goal is denominated in, or null for native /
 * non-treasury. Owner-typed on the goal — the single source for the token the agent
 * tops up + repays in (never model text, never a default on an unknown token).
 */
function treasuryGoalToken(goal: TreasuryGoal | SentinelGoal | TraderGoal | null): string | null {
  if (goal === null) return null;
  const role = goal.type ?? 'treasury';
  if (role !== 'treasury') return null;
  const token = (goal as TreasuryGoal).token;
  return token ? token.toLowerCase() : null;
}

/** D5-2/L-3: the token-denominated inputs to the cross-cycle carry (absent for a native goal). */
interface TokenCarryView {
  beneficiaryWei: string;
  accountWei: string;
  payeeOk: boolean;
}

export function buildTreasuryGraph(
  deps: TreasuryGraphDeps,
  ctx: TreasuryAgentContext,
  checkpointer: BaseCheckpointSaver,
) {
  const fetchFn = deps.fetchFn ?? fetch;
  const coordinator = (): DelegationCoordinator | null => deps.getCoordinator?.() ?? null;
  // Phase-5.5: apply an owner-confirmed directive at the cycle boundary (head node).
  const senseDirection = makeSenseDirection({ pool: deps.pool, hub: deps.hub }, ctx);

  /**
   * Stage D (D-10): the server-authored capability envelope for the prompt — the
   * governed calls this agent may make. Sourced from the read-model (DISPLAY; the
   * on-chain account stays authoritative — the decide node re-derives every
   * authority arg from a LIVE grant-state read). Only the treasury role acts on
   * governed calls autonomously (sentinel delegates, executor is inbound-driven).
   */
  async function senseCapabilities(mode: CycleMode): Promise<CapabilityView[]> {
    const role = ctx.goal.type ?? 'treasury';
    // FR3 (F-8): the trader acts on governed calls too — it is the role a swap
    // capability exists FOR (sentinel delegates, executor is inbound-driven).
    if (role !== 'treasury' && role !== 'trader') return [];
    if (mode.mode !== 'autonomous' && mode.mode !== 'inbound_chain') return [];
    const grants = await listGrants(deps.pool, ctx.agentId);
    return grants.map((g) => ({
      target: g.target,
      selector: g.selector,
      signature: SELECTORS.get(g.selector.toLowerCase())?.signature ?? null,
      perCallCap: g.perCallCap,
    }));
  }

  /** P3C-6(i): snapshot a PolicyView with the contract's own lazy window-rollover math. */
  function toPolicySnapshot(
    policy: Awaited<ReturnType<RuntimeChain['getPolicyView']>>,
    goalToken: string | null = null,
  ): PolicySnapshot {
    const nowSec = Math.floor(Date.now() / 1000);
    // D5-2: a token-goal agent is bound by its TOKEN's budget, not the native one. When that budget is
    // enabled on-chain, the caps/window the agent reads are the token's (marked via assetToken); an
    // unbudgeted token keeps the native view (the decide node raises the "set a budget" ask itself).
    const tokenRow = goalToken
      ? policy.assets?.find((a) => a.enabled && a.token.toLowerCase() === goalToken.toLowerCase())
      : undefined;
    const caps = tokenRow ?? policy;
    const resetsAt = caps.windowStart + caps.windowSeconds;
    const rolled = caps.windowSeconds > 0 && nowSec >= resetsAt;
    const spent = rolled ? 0n : caps.spentInWindow;
    const remaining = caps.windowCap > spent ? caps.windowCap - spent : 0n;
    return {
      ...(tokenRow ? { assetToken: tokenRow.token.toLowerCase() } : {}),
      perTransferCapWei: caps.perTransferCap.toString(),
      windowCapWei: caps.windowCap.toString(),
      windowSeconds: caps.windowSeconds,
      expiresAt: policy.expiresAt,
      allowlist: policy.allowlist.map((a) => a.toLowerCase()),
      revoked: policy.revoked,
      spentInWindowWei: spent.toString(),
      remainingWindowWei: remaining.toString(),
      windowResetsAtUnix: rolled ? nowSec : resetsAt,
    };
  }

  /**
   * FR3 (F-8): trader sense — on-chain token holdings instead of a beneficiary
   * balance. The allowance is read against the SINGLE granted approve-spender on
   * the spend token (the router, from owner grant state — never model text);
   * with no such grant the allowance reads 0 and the ladder stands down.
   */
  async function senseTrader(goal: TraderGoal): Promise<Partial<State>> {
    const grants = await listGrants(deps.pool, ctx.agentId);
    const capabilities: CapabilityView[] = grants.map((g) => ({
      target: g.target,
      selector: g.selector,
      signature: SELECTORS.get(g.selector.toLowerCase())?.signature ?? null,
      perCallCap: g.perCallCap,
    }));
    const approveGrant = grants.find(
      (g) =>
        g.selector.toLowerCase() === SELECTOR_APPROVE &&
        g.target.toLowerCase() === goal.spendToken.toLowerCase() &&
        g.spenderSet.length === 1,
    );
    const spender = approveGrant?.spenderSet[0];
    // FR3b: the granted swap rule (if any) — its band feed prices this cycle's minOut.
    const swapGrant = grants.find((g) => SELECTORS.get(g.selector.toLowerCase())?.swapArgs);
    // AQ-A0-Q2VIS D-3 (token half): read each token's OWN decimals + symbol so the SERVER authors
    // the human-readable label. Without this the trader was handed raw ERC-20 base units and asked
    // to talk about them, so it converted them itself — producing "0.1 0G of the spend token" on
    // the owner-facing surface, which is F-A0-1's exact mislabel shape on a different asset.
    // Instructing the model not to do that is patching the symptom; handing it a correct
    // pre-formatted string removes the need to convert at all (`never-guess-money` — server-read
    // facts, never model-derived).
    //
    // `getErc20Meta` memoizes per token, so this is two reads once per process, not per cycle. A
    // read failure is non-fatal: null meta renders as "<n> units" (honest rather than wrong), and
    // the raw `*Wei` integers the rules compare are untouched either way.
    const tokenMetaOf = (token: string): Promise<{ symbol: string; decimals: number } | null> =>
      deps.chain.getErc20Meta(token).catch(() => null);
    const [account, policy, holdBalance, spendBalance, allowance, bandPrice, holdMeta, spendMeta] = await Promise.all([
      deps.chain.getBalance(ctx.accountAddr),
      deps.chain.getPolicyView(ctx.accountAddr, []),
      deps.chain.getErc20Balance(goal.holdToken, ctx.accountAddr),
      deps.chain.getErc20Balance(goal.spendToken, ctx.accountAddr),
      spender ? deps.chain.getErc20Allowance(goal.spendToken, ctx.accountAddr, spender) : Promise.resolve(0n),
      swapGrant
        ? deps.chain.getSwapBandPrice18(ctx.accountAddr, swapGrant.target, swapGrant.selector)
        : Promise.resolve(null),
      tokenMetaOf(goal.holdToken),
      tokenMetaOf(goal.spendToken),
    ]);
    return {
      beneficiaryBalanceWei: '0',
      accountBalanceWei: account.toString(),
      effectiveBeneficiary: '',
      capabilities,
      bandPrice18: bandPrice !== null ? bandPrice.toString() : null,
      holdings: {
        holdBalanceWei: holdBalance.toString(),
        spendBalanceWei: spendBalance.toString(),
        routerAllowanceWei: allowance.toString(),
      },
      tokenMeta: {
        ...(holdMeta ? { hold: holdMeta } : {}),
        ...(spendMeta ? { spend: spendMeta } : {}),
      },
      policy: toPolicySnapshot(policy),
    };
  }

  /**
   * AQ-A1 D-1/D-2: compose the cross-cycle carry + boundary instruments on top of this cycle's
   * freshly-sensed `base`. Reads the agent's OWN recent trace records (`loadCycleMemory`), diffs the
   * current snapshot against the most recent stored one, and computes the per-role `actionPossible`
   * predicate — all deterministic server data, never model text. A read failure degrades to a cold
   * carry (absence is honest), never throwing the cycle.
   */
  async function composeCarry(
    base: Partial<State>,
    hasInbound: boolean,
    nowSec: number,
    tokenView: TokenCarryView | null = null,
  ): Promise<Partial<State>> {
    // Invariant: both call sites sense `policy` before composing the carry (idle/reject cycles never
    // reach here — they return their own cold carry inline).
    if (!base.policy) throw new Error('composeCarry requires a sensed policy snapshot');
    const policy = base.policy;
    const caps = base.capabilities ?? [];
    // D5-2/L-3: a token-goal agent's carry (change detection + actionPossible) is over its TOKEN
    // balances and its token budget — never the native ones, which made actionPossible false
    // whenever the account held no native coin.
    const snapshot: SenseSnapshot = {
      beneficiaryBalanceWei: tokenView ? tokenView.beneficiaryWei : (base.beneficiaryBalanceWei ?? '0'),
      accountBalanceWei: tokenView ? tokenView.accountWei : (base.accountBalanceWei ?? '0'),
      remainingWindowWei: policy.remainingWindowWei,
      // The FULL grant set fingerprints here (not the ≤8 prompt-view cap) so `capabilitiesChanged`
      // tracks real grant changes, not a reshuffle of which 8 the model happened to see.
      capabilitiesKey: capabilitiesKey(caps),
      ...(base.holdings
        ? {
            holdBalanceWei: base.holdings.holdBalanceWei,
            spendBalanceWei: base.holdings.spendBalanceWei,
            routerAllowanceWei: base.holdings.routerAllowanceWei,
          }
        : {}),
    };
    const { cycleMemory, baselineSnapshot } = await loadCycleMemory(deps.pool, ctx.agentId, nowSec, 10);
    // The composer leaves `delta` null; fill it now that we hold the CURRENT snapshot.
    if (cycleMemory) cycleMemory.delta = computeDelta(snapshot, baselineSnapshot);
    const observedChange = baselineSnapshot ? snapshotsDiffer(snapshot, baselineSnapshot) : true;
    const actionPossible = computeActionPossible({
      goal: ctx.goal,
      // The native allowlist says nothing about a token payee: use the per-token payee verdict.
      policy: tokenView ? { ...policy, allowlist: tokenView.payeeOk ? [(base.effectiveBeneficiary ?? '').toLowerCase()] : [] } : policy,
      beneficiaryBalanceWei: snapshot.beneficiaryBalanceWei,
      accountBalanceWei: snapshot.accountBalanceWei,
      effectiveBeneficiary: base.effectiveBeneficiary ?? '',
      holdings: base.holdings ?? null,
      capabilitiesCount: caps.length,
      hasInbound,
      nowSec,
    });
    return { cycleMemory, actionPossible, observedChange, senseSnapshot: snapshot };
  }

  async function sense(state: State): Promise<Partial<State>> {
    const mode = classifyCycle(ctx.goal, state.inboundDelegation);
    // No transfer intent this cycle (idle executor / rejected inbound): skip
    // the RPC reads — nothing downstream consults them, and the idle executor
    // polls forever (RPC burn for nothing). No carry either — nothing was sensed,
    // and persisting a snapshot of a non-cycle would corrupt the next delta.
    if (mode.mode === 'executor_idle' || mode.mode === 'inbound_reject') {
      return {
        beneficiaryBalanceWei: '0',
        beneficiaryTokenBalanceWei: '0',
        accountBalanceWei: '0',
        effectiveBeneficiary: '',
        capabilities: [],
        holdings: null,
        bandPrice18: null,
        cycleMemory: null,
        actionPossible: false,
        observedChange: false,
        senseSnapshot: null,
        policy: {
          perTransferCapWei: '0',
          windowCapWei: '0',
          windowSeconds: 0,
          expiresAt: 0,
          allowlist: [],
          revoked: false,
          spentInWindowWei: '0',
          remainingWindowWei: '0',
          windowResetsAtUnix: 0,
        },
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const autoGoal = autonomousGoalOf(mode);
    // FR3 (F-8): the trader watches token holdings, not a beneficiary balance.
    if (autoGoal !== null && autoGoal.type === 'trader') {
      const base = await senseTrader(autoGoal);
      return { ...base, ...(await composeCarry(base, false, nowSec)) };
    }
    const beneficiary =
      mode.mode === 'inbound_transfer'
        ? mode.request.beneficiary
        : (autoGoal !== null && 'beneficiary' in autoGoal ? autoGoal.beneficiary : '');
    // AQ-FND M-3: a token-denominated treasury goal watches the beneficiary's ERC-20
    // balance (not native). The token is owner-typed on the goal — never model text.
    const goalToken = treasuryGoalToken(autoGoal);
    const [beneficiaryBalance, beneficiaryTokenBalance, accountTokenBalance, goalTokenMeta, account, policy, capabilities, tokenAsset] = await Promise.all([
      deps.chain.getBalance(beneficiary),
      goalToken && beneficiary ? deps.chain.getErc20Balance(goalToken, beneficiary) : Promise.resolve(0n),
      goalToken ? deps.chain.getErc20Balance(goalToken, ctx.accountAddr) : Promise.resolve(0n),
      // symbol/decimals so DISPLAY labels the real asset; unreadable ⇒ null ⇒ "<n> units" (honest).
      goalToken ? deps.chain.getErc20Meta(goalToken).catch(() => null) : Promise.resolve(null),
      deps.chain.getBalance(ctx.accountAddr),
      deps.chain.getPolicyView(ctx.accountAddr, [beneficiary], goalToken ? [goalToken] : []),
      senseCapabilities(mode),
      goalToken && beneficiary && deps.chain.getAssetPolicy
        ? deps.chain.getAssetPolicy(ctx.accountAddr, goalToken, [beneficiary]).catch(() => null)
        : Promise.resolve(null),
    ]);
    const base: Partial<State> = {
      beneficiaryBalanceWei: beneficiaryBalance.toString(),
      beneficiaryTokenBalanceWei: beneficiaryTokenBalance.toString(),
      accountTokenBalanceWei: accountTokenBalance.toString(),
      accountBalanceWei: account.toString(),
      effectiveBeneficiary: beneficiary,
      ...(goalToken && goalTokenMeta ? { tokenMeta: { hold: goalTokenMeta } } : {}),
      capabilities,
      holdings: null,
      bandPrice18: null,
      // P3C-6(i): window observability with the contract's OWN lazy-rollover
      // math (LeashAccount.execute) — past the boundary the window has
      // logically reset even though storage updates on the next spend.
      policy: toPolicySnapshot(policy, goalToken),
    };
    const tokenView: TokenCarryView | null = goalToken
      ? {
          beneficiaryWei: beneficiaryTokenBalance.toString(),
          accountWei: accountTokenBalance.toString(),
          payeeOk: !!tokenAsset && tokenAsset.enabled && tokenAsset.allowedPayees.includes(beneficiary.toLowerCase()),
        }
      : null;
    return { ...base, ...(await composeCarry(base, mode.mode === 'inbound_transfer', nowSec, tokenView)) };
  }

  async function reason(state: State): Promise<Partial<State>> {
    const mode = classifyCycle(ctx.goal, state.inboundDelegation);
    // Idle executor / rejected inbound: no model call — the outcome is fully
    // deterministic, and reasoning over it would burn 0G Compute per poll
    // (resp. per spam envelope — the coordinator throttles bound issuance,
    // this bounds the receiver side).
    if (mode.mode === 'executor_idle' || mode.mode === 'inbound_reject') {
      return { reasoning: '', deliberation: '', decisionSource: 'empty' as const, finishReason: null, deliberationLoops: 0, promptTokens: null };
    }
    const model = ctx.goal.model ?? deps.defaultModel;
    const body = buildReasonRequest(model, {
      goal: ctx.goal,
      beneficiaryBalanceWei: state.beneficiaryBalanceWei,
      accountBalanceWei: state.accountBalanceWei,
      policy: state.policy,
      nowSec: Math.floor(Date.now() / 1000),
      // AQ-A1 D-1: the server-composed cross-cycle carry. Absent on a cold start — then the prompt is
      // byte-identical to the memoryless baseline, which every first cycle must see.
      //
      // The SHIPPED shape is the round-2 FLAG carry (`cycleFlags`), derived from the same
      // server-composed memory — two booleans the mechanical rules act on, NOT the round-1 prose
      // block (which regressed G-1: truncated 40–52%). Round-2 probe proved the flag shape clears
      // G-1 (0 truncation, completion tokens below the memoryless baseline) + G-2 (100% flip-correct,
      // 100% do-no-harm). Gated by `CARRY_INJECTION_ENABLED` (default on; env `AQ_A1_CARRY=0` to A-B).
      ...(CARRY_INJECTION_ENABLED && state.cycleMemory ? { cycleFlags: deriveCycleFlags(state.cycleMemory) } : {}),
      // FR3 (F-8): the trader's sensed token holdings (absent for other roles).
      ...(state.holdings ? { holdings: state.holdings } : {}),
      ...(state.tokenMeta ? { tokenMeta: state.tokenMeta } : {}),
      // C9: a token-denominated treasury goal reasons over TOKEN balances, not the native ones.
      ...(treasuryGoalToken(autonomousGoalOf(mode)) !== null
        ? {
            tokenTreasury: {
              symbol: state.tokenMeta?.hold?.symbol ?? null,
              decimals: state.tokenMeta?.hold?.decimals ?? null,
              beneficiaryBalanceWei: state.beneficiaryTokenBalanceWei ?? '0',
              accountBalanceWei: state.accountTokenBalanceWei ?? '0',
            },
          }
        : {}),
      // Stage D (D-10): the governed-call envelope the model may act on this cycle.
      ...(state.capabilities && state.capabilities.length > 0 ? { capabilities: state.capabilities } : {}),
      // Inbound delegation rides the observation as LABELED UNTRUSTED input
      // (spec §3b) — the model re-reasons; the decide overlay re-validates.
      ...(state.inboundDelegation ? { inboundDelegation: state.inboundDelegation } : {}),
    });
    // Through OUR OWN gateway — interception + trace + compute queue apply to
    // the hosted agent exactly as to any external client.
    const res = await fetchFn(`${deps.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.gatewayToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const completion: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`gateway refused inference: status ${res.status}`);
    }
    // D-2: read BOTH channels. The decision path still uses only `decisionText`; the deliberation
    // is carried separately instead of being dropped (S-1).
    let channels = completionChannels(completion);
    let text = channels.decisionText;
    if (!parseDecision(text)) {
      // F-4: ONE in-cycle re-ask before the decide overlay stands down — the
      // reasoning model drops an unparsable decision in a large share of
      // cycles, and a second sample usually lands. A failed retry keeps the
      // first output so the trace shows what the model actually said.
      // Best-effort: a retry-transport failure must never kill the cycle the
      // first (traced) response already paid for.
      try {
        const retryRes = await fetchFn(`${deps.gatewayUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ctx.gatewayToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (retryRes.ok) {
          const retryChannels = completionChannels(await retryRes.json().catch(() => null));
          // The retry's deliberation replaces the first only when the retry is the one that
          // decided — otherwise the owner would read thinking that did not produce this decision.
          if (parseDecision(retryChannels.decisionText)) {
            text = retryChannels.decisionText;
            channels = retryChannels;
          }
        }
      } catch {
        /* keep the first output — the decide overlay stands down on it */
      }
    }
    // D-2/D-4 audit layer: the deliberation streams on the `reasoning` channel, which the cockpit
    // renders as a REVIEW surface — one plain line plus "Show the exact model output (raw, for
    // review only)" (Defect-2 option (a)) — with the cycle's health so a degenerate cycle degrades
    // to its signature instead of streaming 64 KB of repetition (C-5).
    const delib = clipDeliberation(channels.deliberation, channels);
    deps.hub.emit(
      ctx.agentId,
      'reasoning',
      reasoningEvent(delib.text || text || '(empty model output)', {
        truncated: channels.finishReason === 'length',
        loopCount: channels.loopCount,
        decisionSource: channels.decisionSource,
        clipped: delib.clipped,
      }),
    );
    if (channels.decisionSource === 'scavenge') {
      // G-6: the scavenge is an ~11% tail event that three retries hide to ~0.14%. Log it the
      // moment it fires; the durable count lives on the trace record (`decisionSource`).
      console.warn(
        `[runtime] agent ${ctx.agentId}: decision scavenged from reasoning_content ` +
          `(finish_reason=${channels.finishReason}, loops=${channels.loopCount})`,
      );
    }
    // AQ-A1 D-3: the per-cycle INPUT budget is a HARD ceiling of 4 096 tokens (matches the
    // completion budget). We never clip the prompt — a clipped money-decision prompt is more
    // dangerous than an expensive one — so a breach is asserted LOUDLY (warn + owner alert) and the
    // cycle proceeds on the full prompt. `promptTokens` rides the trace record so conformance is a
    // durable SQL question, not an in-process guess (the house pattern).
    if (channels.promptTokens !== null && channels.promptTokens > INPUT_TOKEN_CEILING) {
      console.warn(
        `[runtime] agent ${ctx.agentId}: prompt_tokens ${channels.promptTokens} exceeds the ` +
          `${INPUT_TOKEN_CEILING} input-budget ceiling — not clipped; investigate composition.`,
      );
      await deps.alerts?.emit(ctx.agentRow.ownerAddr, {
        agentId: ctx.agentId,
        class: 'info',
        kind: 'input_budget_exceeded',
        summary: `${ctx.agentRow.name}: a reasoning prompt used ${channels.promptTokens} input tokens (budget ${INPUT_TOKEN_CEILING}).`,
        refs: {},
        dedupKey: `input_budget_exceeded:${ctx.agentId}`,
      });
    }
    return {
      reasoning: text,
      deliberation: delib.text,
      decisionSource: channels.decisionSource,
      finishReason: channels.finishReason,
      deliberationLoops: channels.loopCount,
      promptTokens: channels.promptTokens,
    };
  }

  async function decide(state: State): Promise<Partial<State>> {
    const verdict = evaluateDecision(state, ctx);
    // Stage D (D-10): a governed call is classified against a LIVE grant-state
    // read (never native-transfer window damping — its caps live on-chain +
    // in classify). Resolve it BEFORE the transfer-damping block.
    if (verdict.route === 'call') return decideCall(state, verdict.decision);
    if (verdict.route === 'tool_call') return decideToolCall(state, verdict.decision);
    if (verdict.route === 'sign') return decideSign(state, verdict.decision);
    // AQ-FND M-3: a token top-up — resolve spendability (novel-token one-ask) + the
    // self-funding gas ladder against LIVE on-chain state BEFORE any submit (mirrors
    // decideCall). Its caps/gas are chain-enforced, so it bypasses the native-transfer
    // window damping block below.
    if (verdict.route === 'token_act') return decideTokenAct(state, verdict.decision);
    // P3C-6(iii): boundary damping. Refresh clear conditions first (window
    // reset / policy change / re-arm — clearing resolves the limit_hit
    // alert and re-enables normal flow), then short-circuit outcomes that
    // would re-hit an ACTIVE boundary to a traced stand-down (no gas).
    if (deps.boundaries && ctx.goal.type !== 'sentinel') {
      const nowSec = Math.floor(Date.now() / 1000);
      const refreshed = deps.boundaries.refresh(ctx.agentId, state.policy, nowSec);
      if (refreshed.status === 'cleared') {
        await deps.alerts?.resolveByDedupKey(ctx.agentRow.ownerAddr, refreshed.boundary.dedupKey);
      } else if (refreshed.status === 'active' && (verdict.route === 'act' || verdict.route === 'approval')) {
        const b = refreshed.boundary;
        if (
          b.errorName === 'OverWindowCap' &&
          BigInt(verdict.decision.amountWei) <= BigInt(state.policy.remainingWindowWei)
        ) {
          // The CURRENT proposal fits the remaining window — the boundary no
          // longer describes a doomed send. Clear it (resolving its limit_hit
          // alert) and fall through to normal flow instead of standing down.
          deps.boundaries.clear(ctx.agentId);
          await deps.alerts?.resolveByDedupKey(ctx.agentRow.ownerAddr, b.dedupKey);
        } else {
          const until = b.clearsAtUnix !== null ? ` until ${new Date(b.clearsAtUnix * 1000).toISOString()}` : '';
          return {
            decision: {
              action: 'stand_down',
              amountWei: '0',
              reason: `boundary active (${b.errorName})${until} — standing down instead of retrying a doomed send`,
            },
            route: 'stand_down',
          };
        }
      }
      // Boundary TOUCHED (00 §1a): the goal wants a transfer but the window
      // is exhausted — the leash is binding whether or not the model politely
      // stands down on its own. One limit_hit tells the owner; damping holds
      // until the window resets or policy changes. (windowCap 0 = the
      // spend-incapable shape — never a window boundary.)
      const mode = classifyCycle(ctx.goal, state.inboundDelegation);
      const autoGoal = autonomousGoalOf(mode);
      const wantsTransfer =
        mode.mode === 'inbound_transfer' ||
        (autoGoal !== null &&
          'targetBalanceWei' in autoGoal && // trader never wants a native transfer
          BigInt(treasuryGoalToken(autoGoal) !== null ? state.beneficiaryTokenBalanceWei : state.beneficiaryBalanceWei) <
            BigInt(autoGoal.targetBalanceWei));
      if (
        wantsTransfer &&
        BigInt(state.policy.windowCapWei) > 0n &&
        BigInt(state.policy.remainingWindowWei) === 0n
      ) {
        await activateBoundary(state, 'OverWindowCap', state.policy.windowResetsAtUnix);
        return {
          decision: {
            action: 'stand_down',
            amountWei: '0',
            reason: 'spending window exhausted — standing down until it resets',
          },
          route: 'stand_down',
        };
      }
      // Pre-flight window detection: a send provably over the remaining
      // window allowance never reaches the chain (no gas burned on the
      // revert). The boundary ACTIVATES only when the window is fully
      // exhausted (remaining === 0) — with allowance left the model can
      // retry smaller next cycle, so a plain stand-down suffices (no
      // damping, no limit_hit).
      if (
        (verdict.route === 'act' || verdict.route === 'approval') &&
        BigInt(verdict.decision.amountWei) > BigInt(state.policy.remainingWindowWei)
      ) {
        if (BigInt(state.policy.remainingWindowWei) === 0n) {
          await activateBoundary(state, 'OverWindowCap', state.policy.windowResetsAtUnix);
          return {
            decision: {
              action: 'stand_down',
              amountWei: '0',
              reason: 'over the remaining window allowance — standing down until the window resets',
            },
            route: 'stand_down',
          };
        }
        return {
          decision: {
            action: 'stand_down',
            amountWei: '0',
            reason: 'proposed amount exceeds the remaining window allowance — retry smaller next cycle',
          },
          route: 'stand_down',
        };
      }
    }
    if (verdict.route !== 'approval') return verdict;
    // Side effects live HERE (a completed, checkpointed node) — the interrupt
    // node re-executes from its top on resume, which would duplicate rows.
    const approval = await createApproval(deps.pool, ctx.agentId, {
      kind: 'transfer',
      to: state.effectiveBeneficiary,
      valueWei: verdict.decision.amountWei,
      reason: verdict.decision.reason,
    });
    deps.hub.emit(
      ctx.agentId,
      'approval',
      approvalEvent({
        approvalId: approval.id,
        summary: `agent wants to send ${formatG(verdict.decision.amountWei)} (over per-transfer cap)`,
        to: state.effectiveBeneficiary,
        valueWei: verdict.decision.amountWei,
      }),
    );
    // Daily loop (spec §3b): decision alert on the runtime interrupt
    // boundary — RICH but strictly server-side facts (amount, recipient,
    // allowlist status, caps context, deadline). Nothing model-authored.
    if (deps.alerts) {
      const to = state.effectiveBeneficiary;
      const allowlisted = state.policy.allowlist.includes(to.toLowerCase());
      const deadline =
        deps.approvalTimeoutMs !== undefined
          ? ` ⏱ Auto-denies ${inMinutes(deps.approvalTimeoutMs)} if you don't answer.`
          : ' ⏱ Auto-denies if you don\'t answer in time.';
      // The agent's own stated purpose (00 §6b) — UNTRUSTED, so it is sanitized
      // (control chars stripped, one line, capped) and carried in refs, NOT the
      // verified summary. Each surface renders it labeled + quoted + quarantined
      // (Telegram appends a line; the app shows a distinct block) so the owner
      // sees WHY without the card becoming a persuasion/injection surface.
      const intent = sanitizeAgentIntent(verdict.decision.reason);
      await deps.alerts.emit(ctx.agentRow.ownerAddr, {
        agentId: ctx.agentId,
        class: 'decision',
        kind: 'approval_required',
        summary:
          `${ctx.agentRow.name} wants to send ${formatG(verdict.decision.amountWei)} to ${shortAddr(to)}` +
          `${allowlisted ? ' (✓ on its allowlist)' : ''} — over its per-transfer cap of ${formatG(state.policy.perTransferCapWei)}. ` +
          `Window used: ${formatG(state.policy.spentInWindowWei)} of ${formatG(state.policy.windowCapWei)}.` +
          deadline,
        refs: {
          approvalId: approval.id,
          amountWei: verdict.decision.amountWei,
          to,
          ...(intent ? { agentIntent: intent } : {}),
          ...(deps.approvalTimeoutMs !== undefined
            ? { autoDeniesAtUnix: Math.floor((Date.now() + deps.approvalTimeoutMs) / 1000) }
            : {}),
        },
      });
    }
    return { ...verdict, approvalId: approval.id };
  }

  async function act(state: State): Promise<Partial<State>> {
    return { outcome: await transfer(state, state.effectiveBeneficiary, state.decision.amountWei) };
  }

  /**
   * AQ-FND M-3: raise EXACTLY ONE owner ask on the existing alert rail and stand down —
   * never a parallel escalation, never a doomed submit. Deduped per key so the same ask
   * is not re-raised every cycle (mirrors how activateBoundary / the novel-call path
   * avoid dup rows). Used for both the novel-token ask (D-1) and the rung-5 gas ask (D-4).
   */
  async function askOwnerAndStandDown(
    kind: 'capability_request' | 'gas_request',
    summary: string,
    dedupKey: string,
    reason: string,
  ): Promise<Partial<State>> {
    if (deps.alerts) {
      await deps.alerts.emit(ctx.agentRow.ownerAddr, {
        agentId: ctx.agentId,
        class: 'decision',
        kind,
        summary,
        refs: {},
        dedupKey,
      });
    }
    return { decision: { action: 'stand_down', amountWei: '0', reason }, route: 'stand_down' };
  }

  /**
   * AQ-FND M-3: resolve a token top-up (mirror of decideCall). Order (never-guess-money,
   * D-4, D-1):
   *   1. Spendability (D-1 hinge): the token's V6 asset policy must be ENABLED and the
   *      beneficiary an allowlisted payee for it. If not → ONE owner ask ("set a budget")
   *      and stand down — never a doomed tx. Deduped per token.
   *   2. Gas route (D-4): survey every chain the agent is on and call planGasRoute (home target).
   *      has-native → submit the token transfer directly (via the tokenAct node).
   *      account-native → refuel the key through the wall, then act as has-native.
   *      swap-to-gas|bridge-then-swap|ask-owner → ONE gas ask + stand down (deduped per chain+mode).
   */
  async function decideTokenAct(state: State, decision: AgentDecision): Promise<Partial<State>> {
    if (state.policy.revoked) return standDownToken('account revoked since sense');
    const token = treasuryGoalToken(autonomousGoalOf(classifyCycle(ctx.goal, state.inboundDelegation)));
    if (!token) return standDownToken('token top-up without a goal token — standing down');
    const beneficiary = state.effectiveBeneficiary;
    const amountWei = BigInt(decision.amountWei);
    if (amountWei <= 0n) return standDownToken('non-positive token top-up amount');

    // (1) Spendability — the D-1 novel-token hinge. Absent getAssetPolicy ⇒ fail-closed.
    if (!deps.chain.getAssetPolicy) {
      return standDownToken('token spendability unreadable on this chain — standing down');
    }
    const assetPolicy = await deps.chain.getAssetPolicy(ctx.accountAddr, token, [beneficiary]);
    const beneficiaryIsPayee = assetPolicy.allowedPayees.includes(beneficiary.toLowerCase());
    if (!assetPolicy.enabled || !beneficiaryIsPayee) {
      // spend-novel = ONE ask per MISSING PIECE, never a silent stall. Allowing a token takes two owner
      // acts (a budget, then an approved recipient FOR THAT TOKEN), each behind its own safety delay, so
      // the ask names what is missing and the dedup key changes when the missing piece does — the owner
      // gets one ask for the budget, then (once it lands) one for the recipient, never a repeat of either.
      const missing = !assetPolicy.enabled ? (beneficiaryIsPayee ? 'budget' : 'budget+payee') : 'payee';
      const who = shortAddr(beneficiary);
      const summary =
        missing === 'budget'
          ? `${ctx.agentRow.name} wants to spend ${shortAddr(token)} but it has no budget — set one to allow it.`
          : missing === 'budget+payee'
            ? `${ctx.agentRow.name} wants to spend ${shortAddr(token)} but it has no budget — set one to allow it, and approve ${who} as a recipient for it.`
            : `${ctx.agentRow.name} wants to send ${shortAddr(token)} to ${who}, but that wallet is not an approved recipient for it yet — approve it to allow this.`;
      return askOwnerAndStandDown(
        'capability_request',
        summary,
        `token_novel:${ctx.agentId}:${token}:${missing}`,
        missing === 'payee'
          ? 'token has a budget but the beneficiary is not an approved recipient for it — raised one owner ask'
          : 'token not spendable (no enabled budget) — raised one owner ask',
      );
    }

    // (2) Gas ladder. Absent gasConfig ⇒ act as the native path (no ladder, no regression).
    if (!deps.gasConfig) {
      return { decision, route: 'token_act', tokenActToken: token, tokenActAmountWei: amountWei.toString(), tokenActGasRung: 'has-native' };
    }
    const sessionKeyAddr = ctx.agentRow.sessionKeyAddr ?? '';
    const gasConfig = deps.gasConfig;
    const cfg = buildGasRouteConfig(gasConfig.chainConfig, gasConfig.globalDustWei);
    const route = await planTokenGasRoute(gasConfig, token, sessionKeyAddr);
    const chainId = route.targetChainId;
    const actWith = (rung: string): Partial<State> =>
      ({ decision, route: 'token_act', tokenActToken: token, tokenActAmountWei: amountWei.toString(), tokenActGasRung: rung });
    const gasAsk = (reason: string): Promise<Partial<State>> =>
      askOwnerAndStandDown('gas_request', gasAskSummary(gasConfig, route), `gas_request:${ctx.agentId}:${chainId}:${route.mode}`, reason);

    switch (route.mode) {
      case 'has-native':
        return actWith('has-native');
      case 'account-native': {
        // Refuel the key through the governed wall, then act (treated as has-native this cycle).
        try {
          await deps.chain.executeTransfer({
            sessionPrivateKey: ctx.sessionPrivateKey,
            accountAddr: ctx.accountAddr,
            to: sessionKeyAddr,
            valueWei: cfg.refuelWei,
          });
        } catch (err) {
          return standDownToken(`account-native refuel failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return actWith('account-native');
      }
      case 'swap-to-gas':
        return decideGasSwap(decision, route, gasConfig, sessionKeyAddr, gasAsk);
      case 'bridge-then-swap':
        return decideGasBridge(decision, route, gasConfig, gasAsk);
      case 'ask-owner':
      default:
        return gasAsk('waiting for gas: it has no way to pay for gas on its own here, so it asked you once (see your inbox)');
    }
  }

  /**
   * AQ-FND M-3 inc-3a: resolve a `swap-to-gas` route. Every swap-side leg is built server-side
   * (`buildGasSwapCalls`) and run through the EXISTING classify against the owner's live grants:
   *   all L1      -> route `gas_swap` (gasSwapAct runs the legs; the NEXT cycle re-plans has-native)
   *   a leg is L2 -> the EXISTING capability request for the FIRST uncovered leg (deduped by callHash)
   *   forbidden / no executor config / no native payee -> ONE `gas_request` ask naming the blocker
   * Nothing is submitted here. The relayer is never involved.
   */
  async function decideGasSwap(
    decision: AgentDecision,
    route: GasRoute,
    gasConfig: NonNullable<TreasuryGraphDeps['gasConfig']>,
    sessionKeyAddr: string,
    gasAsk: (reason: string) => Promise<Partial<State>>,
  ): Promise<Partial<State>> {
    const token = route.legs.find((l) => l.kind === 'swap')?.token;
    if (!token || !gasSwapSetup(gasConfig.chainConfig)) {
      return gasAsk('swap-to-gas route found but this chain has no gas-swap config — raised one gas ask with the required grants');
    }
    const pre = await precheckGasSwap(gasSwapEnv(gasConfig), token, sessionKeyAddr);
    if (pre.ok) {
      return { decision, route: 'gas_swap', gasSwapToken: token, gasSwapAmountIn: pre.amountIn.toString() };
    }
    if (pre.kind === 'l2') {
      if (!deps.capabilities) return standDownToken('swap-to-gas leg needs owner approval — no capability rail configured, standing down');
      await raiseCapabilityRequest(deps.capabilities, ctx.agentRow, pre.gate);
      return standDownToken(`swap-to-gas ${pre.leg} leg is not covered by the owner's grants — raised a capability request`);
    }
    if (pre.kind === 'forbidden') {
      return askOwnerAndStandDown(
        'gas_request',
        `${gasAskSummary(gasConfig, route)} The ${pre.leg} step is blocked (${pre.reason}).`,
        `gas_request:${ctx.agentId}:${route.targetChainId}:swap-to-gas:${pre.leg}:${pre.reason}`,
        `swap-to-gas ${pre.leg} leg forbidden (${pre.reason}) — raised one gas ask`,
      );
    }
    return gasAsk(`swap-to-gas not executable (${pre.reason}) — raised one gas ask with the required grants`);
  }

  function gasSwapEnv(gasConfig: NonNullable<TreasuryGraphDeps['gasConfig']>): GasSwapEnv {
    return {
      pool: deps.pool,
      chain: deps.chain,
      agentId: ctx.agentId,
      accountAddr: ctx.accountAddr,
      chainConfig: gasConfig.chainConfig,
      bridgeTargets: deps.bridge?.targets,
    };
  }

  function gasBridgeEnv(gasConfig: NonNullable<TreasuryGraphDeps['gasConfig']>, srcChainId: number, destChainId: number): GasBridgeEnv | null {
    const resolve = deps.gasRoute?.resolveChain;
    const configOf = deps.gasRoute?.chainConfigOf;
    const gate = deps.bridge?.assertRoutable;
    if (!resolve || !configOf || !gate) return null;
    const homeCfg = buildRouteChainCfg(gasConfig.chainConfig, gasConfig.globalDustWei);
    return {
      pool: deps.pool,
      srcChain: resolve(srcChainId),
      srcChainConfig: configOf(srcChainId),
      agentId: ctx.agentId,
      accountAddr: ctx.accountAddr,
      destChainId,
      amountCap: gasConfig.chainConfig.gasSwap?.tokenAmount ?? 0n,
      fillGasWei: homeCfg.refuelLegGasWei,
      assertRoutable: (target, decoded) => gate(target, decoded, srcChainId),
    };
  }

  /**
   * AQ-FND M-3 inc-3b: resolve a `bridge-then-swap` route (the SOURCE half; the mint and the swap
   * follow on later cycles). While a bridge into this chain is open the agent just waits. Every call
   * is built server-side and classified against the owner's live grants ON THE SOURCE CHAIN, then the
   * bridge-gate runs. Anything not runnable is ONE `gas_request` ask naming the blocker - never a
   * capability card, because the cockpit grants rules on the agent's home chain only.
   */
  async function decideGasBridge(
    decision: AgentDecision,
    route: GasRoute,
    gasConfig: NonNullable<TreasuryGraphDeps['gasConfig']>,
    gasAsk: (reason: string) => Promise<Partial<State>>,
  ): Promise<Partial<State>> {
    const leg = route.legs.find((l) => l.kind === 'bridge');
    const env = leg ? gasBridgeEnv(gasConfig, leg.chainId, route.targetChainId) : null;
    if (!leg || !env || !leg.token) {
      return gasAsk('bridge-then-swap route found but the bridge rail is not configured on this runtime — raised one gas ask with the required grants');
    }
    if (await hasOpenBridgeInto(deps.pool, ctx.agentId, route.targetChainId)) {
      return standDownToken('a bridge into this chain is already in flight — waiting for it to land before acting again');
    }
    const pre = await precheckGasBridge(env, leg.token);
    if (pre.ok) {
      return { decision, route: 'gas_bridge', gasBridgeToken: leg.token, gasBridgeAmount: pre.amount.toString(), gasBridgeSrcChain: leg.chainId };
    }
    if (pre.kind === 'unavailable') return gasAsk(`bridge-then-swap not executable (${pre.reason}) — raised one gas ask with the required grants`);
    const why = pre.kind === 'l2' ? 'is not covered by the owner\'s grants on the source chain' : `is blocked (${pre.reason})`;
    return askOwnerAndStandDown(
      'gas_request',
      `${gasAskSummary(gasConfig, route)} The ${pre.leg} step ${why}.`,
      `gas_request:${ctx.agentId}:${route.targetChainId}:bridge-then-swap:${pre.leg}:${pre.kind}`,
      `bridge-then-swap ${pre.leg} leg ${why} — raised one gas ask`,
    );
  }

  /**
   * AQ-FND M-3 inc-3b: run the bridge SOURCE leg (approve -> burn) with the SESSION key on the source
   * chain. ONE outcome per cycle; a failed leg stops the sequence (the rail row is already marked
   * failed). A success stands the cycle down on the burn itself: the sweep mints, and a later cycle
   * finds the USDC on this chain and runs the swap-to-gas rung.
   */
  async function gasBridgeAct(state: State): Promise<Partial<State>> {
    const gasConfig = deps.gasConfig;
    const env = gasConfig ? gasBridgeEnv(gasConfig, state.gasBridgeSrcChain, gasConfig.chainConfig.chainId) : null;
    if (!gasConfig || !env) return { outcome: { type: 'failed', reason: 'gas-bridge config vanished before submit' } };
    const token = state.gasBridgeToken as Address;
    const amount = BigInt(state.gasBridgeAmount);
    try {
      const { txHashes } = await executeGasBridge(env, { sessionPrivateKey: ctx.sessionPrivateKey, token, amount });
      const meta = await env.srcChain.getErc20Meta?.(token).catch(() => null);
      const sentLabel = formatAssetAmount(amount, meta?.decimals ?? null, meta?.symbol ?? shortAddr(token));
      return {
        outcome: {
          type: 'acted',
          txHash: txHashes[txHashes.length - 1] ?? '',
          valueWei: amount.toString(),
          token,
          gasRung: 'bridge-then-swap',
          gasBought: `bridging for gas: sent ${sentLabel} from ${env.srcChainConfig.name} toward ${gasConfig.chainConfig.name}; it lands in a few minutes, then the agent swaps part of it for gas`,
        },
      };
    } catch (err) {
      const leg = err instanceof GasBridgeLegError ? err.leg : 'bridge';
      const cause = err instanceof GasBridgeLegError ? err.cause : err;
      const decoded = decodeLeashError(cause);
      const reason = decoded
        ? `bridge-then-swap ${leg} leg refused: ${decoded.plain}`
        : `bridge-then-swap ${leg} leg failed: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`;
      return { outcome: { type: 'failed', reason, ...(decoded ? { decoded } : {}) } };
    }
  }

  /**
   * AQ-FND M-3 inc-3a: run the swap-to-gas legs (approve -> swap -> unwrap -> refuel) with the
   * SESSION key, each awaited to a successful receipt. ONE outcome per cycle; a failed leg stops
   * the sequence (no retry loop - the next cycle re-plans from chain state). A success stands the
   * cycle down on the top-up itself: the next cycle sees native and proceeds as has-native.
   */
  async function gasSwapAct(state: State): Promise<Partial<State>> {
    const gasConfig = deps.gasConfig;
    if (!gasConfig) return { outcome: { type: 'failed', reason: 'gas-swap config vanished before submit' } };
    const token = state.gasSwapToken as Address;
    const amountIn = BigInt(state.gasSwapAmountIn);
    try {
      const hashes = await executeGasSwap(gasSwapEnv(gasConfig), {
        sessionPrivateKey: ctx.sessionPrivateKey,
        sessionKeyAddr: ctx.agentRow.sessionKeyAddr ?? '',
        token,
        amountIn,
        refuelWei: buildGasRouteConfig(gasConfig.chainConfig, gasConfig.globalDustWei).refuelWei,
      });
      return {
        outcome: {
          type: 'acted',
          txHash: hashes[hashes.length - 1] ?? '',
          valueWei: amountIn.toString(),
          token,
          gasRung: 'swap-to-gas',
          gasBought: `bought gas: swapped ${amountIn.toString()} units of ${shortAddr(token)} for native on ${gasConfig.chainConfig.name}`,
        },
      };
    } catch (err) {
      const leg = err instanceof GasSwapLegError ? err.leg : 'swap-to-gas';
      const cause = err instanceof GasSwapLegError ? err.cause : err;
      const decoded = decodeLeashError(cause);
      const reason = decoded
        ? `swap-to-gas ${leg} leg refused: ${decoded.plain}`
        : `swap-to-gas ${leg} leg failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      return { outcome: { type: 'failed', reason, ...(decoded ? { decoded } : {}) } };
    }
  }

  /** Survey every chain the agent is on and plan the HOME-chain gas route (read-only). */
  async function planTokenGasRoute(
    gasConfig: NonNullable<TreasuryGraphDeps['gasConfig']>,
    token: string,
    sessionKeyAddr: string,
  ): Promise<GasRoute> {
    const { chainConfig, globalDustWei } = gasConfig;
    const inputs: GasRouteInputs = deps.gasRoute
      ? await deps.gasRoute.load(token)
      : {
          homeChainId: chainConfig.chainId,
          chainIds: [chainConfig.chainId],
          cfgByChain: { [chainConfig.chainId]: buildRouteChainCfg(chainConfig, globalDustWei) },
          tokensByChain: { [chainConfig.chainId]: [token] },
          lanes: [],
        };
    const { route } = await planAgentGasRoute({
      inputs,
      resolveChain: deps.gasRoute?.resolveChain ?? (() => deps.chain),
      accountAddr: ctx.accountAddr,
      sessionKeyAddr,
    });
    return route;
  }

  /** The owner-facing, plain-wording summary of a route that cannot run by itself. */
  function gasAskSummary(gasConfig: NonNullable<TreasuryGraphDeps['gasConfig']>, route: GasRoute): string {
    return describeGasAsk({
      agentName: ctx.agentRow.name,
      route,
      chainName: (id) => deps.gasRoute?.chainName(id) ?? (id === gasConfig.chainConfig.chainId ? gasConfig.chainConfig.name : `chain ${id}`),
    });
  }

  function standDownToken(reason: string): Partial<State> {
    return { decision: { action: 'stand_down', amountWei: '0', reason }, route: 'stand_down' };
  }

  /**
   * AQ-FND M-3: the token top-up executor: a single governed executeTokenTransfer (the on-chain
   * wall meters it), after the gas ladder has secured native gas for the session key. There is
   * no relayer-fronted path: LEASH never sponsors gas.
   */
  async function tokenAct(state: State): Promise<Partial<State>> {
    const token = state.tokenActToken;
    const to = state.effectiveBeneficiary;
    const amountWei = BigInt(state.tokenActAmountWei);
    const rung = state.tokenActGasRung;
    try {
      const { txHash } = await deps.chain.executeTokenTransfer({
        sessionPrivateKey: ctx.sessionPrivateKey,
        accountAddr: ctx.accountAddr,
        token,
        to,
        amountWei,
      });
      return { outcome: { type: 'acted', txHash, valueWei: amountWei.toString(), token, gasRung: rung } };
    } catch (err) {
      const decoded = decodeLeashError(err);
      const reason = decoded
        ? `token top-up refused: ${decoded.plain}`
        : `token top-up failed: ${err instanceof Error ? err.message : String(err)}`;
      return { outcome: { type: 'failed', reason, ...(decoded ? { decoded } : {}) } };
    }
  }

  /**
   * Stage D (D-10): resolve a governed `call` intent. The model chose only a
   * granted (target, selector) + amount; EVERY authority arg (spender/recipient/
   * from) is pinned from a LIVE on-chain grant-state read (never-guess-money), then
   * the built calldata is re-classified against that same envelope:
   *   L1 (in-envelope)  → route 'call' (silent on-chain submit via executeCall)
   *   L2 (novel)        → raise a quarantined JIT request (NOT a doomed submit, P3C-6)
   *   forbidden / unbuildable → stand down, traced (never a fabricated call)
   * The on-chain V4 wall is the sole enforcement guarantee regardless.
   */
  async function decideCall(state: State, decision: AgentDecision): Promise<Partial<State>> {
    const self = ctx.accountAddr;
    const standDownResult = (reason: string): Partial<State> => ({
      decision: { action: 'stand_down', amountWei: '0', reason },
      route: 'stand_down',
    });
    // W3 (code-review 2026-09-28): evaluateDecision already gated revoke/expiry
    // at SENSE time, but a 30s cycle leaves a window where the session lapses
    // between sense and here. Re-check the absolute expiry against fresh time so
    // we never burn gas on a doomed submit the wall would revert (P3C-6). Revoke
    // is a rarer race and is caught by the wall regardless.
    if (state.policy.revoked) return standDownResult('account revoked since sense — not submitting');
    if (state.policy.expiresAt <= Math.floor(Date.now() / 1000)) {
      return standDownResult('session expired since sense — not submitting a doomed governed call');
    }
    const grant = await loadGrantState(deps.pool, deps.chain, ctx.agentId, self, deps.bridge?.targets);
    // FR3 (F-8/FR3b): the trader's swap free args resolve from its OWNER-TYPED
    // goal tokens + SERVER-READ on-chain state — never model text. minOut derives
    // from the band feed price sensed THIS cycle (implied price == oracle →
    // dead-center in-band); with no band it falls back to 1 (unguarded testnet
    // mock). The wall re-reads the feed at submit, so a feed move between sense
    // and submit reverts PremiumBreach/StaleOracle — the refusal the demo shows.
    let trade: TradeFill | undefined;
    if (ctx.goal.type === 'trader') {
      let minOutWei = 1n;
      if (state.bandPrice18) {
        const price = BigInt(state.bandPrice18);
        if (price > 0n) {
          const derived = (BigInt(decision.amountWei) * 10n ** 18n) / price;
          if (derived > 0n) minOutWei = derived;
        }
      }
      trade = {
        tokenIn: ctx.goal.spendToken,
        tokenOut: ctx.goal.holdToken,
        minOutWei,
        deadlineSec: Math.floor(Date.now() / 1000) + 600,
      };
    }
    const built = buildGovernedCall(
      { target: decision.target ?? '', selector: decision.selector ?? '', amountWei: decision.amountWei },
      grant,
      self,
      trade,
    );
    if (!built.ok) {
      // An authority arg couldn't be pinned from grant state (no grant, ambiguous
      // spender, allowlist recipient, free-route arg, bad amount, unknown selector).
      return standDownResult(`governed call not authority-determined (${built.reason})`);
    }
    const gate = classifyIntendedCall(built.target, built.value, built.data, grant, self);
    if (gate.classification.lane === 'l1') {
      // SE-8 (carry #1): a BRIDGE call routes funds cross-chain — the HARD
      // pre-routing gate must PASS first: same-CREATE2-address verification on
      // home + destination, bound to the persisted account (assertSameAddress's
      // first production caller). Refusal/absence = stand down, traced — never
      // a bridge submit whose far leg is unverified (fail-closed).
      if (BRIDGE_SELECTORS.has(built.data.slice(0, 10).toLowerCase())) {
        if (!deps.bridge) {
          return standDownResult('bridge call refused: no bridge lane configured (pre-routing gate unavailable)');
        }
        try {
          const routed = await deps.bridge.assertRoutable(built.target, gate.decoded);
          return {
            decision,
            route: 'call',
            callTarget: built.target,
            callData: built.data,
            callValue: built.value.toString(),
            reasoning:
              state.reasoning +
              ` [bridge pre-routing gate PASSED: same-address ${routed.verifiedAddr} verified on destination chain ${routed.destinationChainId}]`,
          };
        } catch (err) {
          return standDownResult(
            `bridge call refused by the pre-routing gate: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return {
        decision,
        route: 'call',
        callTarget: built.target,
        callData: built.data,
        callValue: built.value.toString(),
      };
    }
    if (gate.classification.lane === 'l2') {
      // Novel → the L2 JIT rail (owner grants on-chain before it can ever run).
      if (deps.capabilities) {
        await raiseCapabilityRequest(deps.capabilities, ctx.agentRow, gate);
        return standDownResult('novel governed call — raised a capability request for owner approval');
      }
      return standDownResult('novel governed call — no capability rail configured, standing down');
    }
    return standDownResult(`governed call forbidden (${gate.classification.reason})`);
  }

  async function callAct(state: State): Promise<Partial<State>> {
    try {
      const { txHash } = await deps.chain.executeCall({
        sessionPrivateKey: ctx.sessionPrivateKey,
        accountAddr: ctx.accountAddr,
        target: state.callTarget,
        valueWei: BigInt(state.callValue),
        data: state.callData,
      });
      return { outcome: { type: 'acted', txHash, valueWei: state.callValue, callTarget: state.callTarget } };
    } catch (err) {
      // The on-chain wall refused (a boundary hit) — record, never crash; never
      // recorded as a completed action (assertReceiptSuccess throws on revert).
      const decoded = decodeLeashError(err);
      const reason = decoded
        ? `governed call refused: ${decoded.plain}`
        : `governed call failed: ${err instanceof Error ? err.message : String(err)}`;
      return { outcome: { type: 'failed', reason, ...(decoded ? { decoded } : {}) } };
    }
  }

  /**
   * SF-3 — the governed tool-use decide node (mirror of `decideCall`). Routes a
   * `tool_call` through the SAME tool-gate the MCP gateway uses, grant-state only:
   * forbidden/absent-rail → stand down; L2 (sensitive or policy edge) → raise a
   * JIT request + stand down; L1 → resolve the egress leg and route to `toolAct`.
   */
  async function decideToolCall(state: State, decision: AgentDecision): Promise<Partial<State>> {
    const standDownResult = (reason: string): Partial<State> => ({
      decision: { action: 'stand_down', amountWei: '0', reason },
      route: 'stand_down',
    });
    if (state.policy.revoked) return standDownResult('account revoked since sense — not using a tool');
    const rail = deps.toolRail;
    if (!rail) return standDownResult('tool_call requested but no tool rail configured — standing down');
    const toolId = decision.toolId ?? '';
    const grant = await rail.loadGrant(ctx.agentId);
    const gate = gateToolCall(toolId, decision.toolArgs ?? {}, rail.registry, grant, rail.maxIoBytes);

    if (gate.classification.lane === 'forbidden') {
      return standDownResult(`tool call forbidden (${gate.classification.reason})`);
    }
    if (gate.classification.lane === 'l2') {
      await raiseToolRequest(rail.service, ctx.agentRow, gate);
      return standDownResult(`tool call needs owner approval (${gate.classification.triggers.join(', ')}) — raised a tool request`);
    }
    // L1 — resolve the egress leg; defence-in-depth (classify forbade no-endpoint).
    if (!gate.endpoint || !gate.descriptor) return standDownResult('tool call egress not resolvable — standing down');
    return {
      decision,
      route: 'tool_call',
      toolIdResolved: gate.toolId,
      toolName: gate.descriptor.name,
      toolEndpoint: gate.endpoint,
      toolArgs: gate.guardedArgs,
    };
  }

  /**
   * SF-3 — execute an L1 governed tool call via the egress proxy and record a
   * `tool_used` outcome (symmetric with `callAct`). The RESULT is I/O-guarded
   * before it ever leaves this node (prompt-injection-via-result / exfiltration /
   * proto-pollution, F-3b); a rejected result is recorded as an error outcome.
   */
  async function toolAct(state: State): Promise<Partial<State>> {
    const rail = deps.toolRail;
    if (!rail) return { outcome: { type: 'stood_down', reason: 'tool rail disappeared before execution' } };
    try {
      const result = await rail.executor.call(state.toolEndpoint, state.toolName, state.toolArgs);
      const guarded = guardToolResult(result.content ?? [], rail.maxIoBytes);
      const isError = result.isError === true || !guarded.ok;
      return { outcome: { type: 'tool_used', toolId: state.toolIdResolved, ...(isError ? { isError: true } : {}) } };
    } catch (err) {
      return {
        outcome: { type: 'failed', reason: `tool call failed: ${err instanceof Error ? err.message : String(err)}` },
      };
    }
  }

  /**
   * FP-3 — the governed signing decide node (mirror of `decideCall`/`decideToolCall`). Routes a
   * `sign` through the SAME engine the owner routes use, grant-state only:
   *   forbidden / L3-widen → stand down (an out-of-grant sign would REVERT on-chain; the resolution
   *     is a timelocked owner widen, never a doomed arm — P3C-6);
   *   L2 (sensitive)       → raise a quarantined JIT request + stand down (armed on owner consent);
   *   L1                   → never-guess-money BUILD + route 'sign' → `signAct` (session-key arm).
   * The built digest + leaf words are server-held; the human card is derived from server fields via
   * the builder (`decodeForHuman`), NEVER agent text (D-FP2-6 / signing-service M-01).
   */
  /** The deadline window (seconds) to derive the sign deadline from: the owner grant's
   * `maxDeadlineWindow` when granted (so the built deadline sits inside the on-chain bound), else a
   * small positive default (an un-granted descriptor classifies L3 and never reaches the arm). */
  function windowForGrant(grant: SigningGrantState, descriptorId: number): number {
    const rule = grant.rules.get(descriptorId);
    return rule && rule.maxDeadlineWindow > 0 ? rule.maxDeadlineWindow : 600;
  }

  async function decideSign(state: State, decision: AgentDecision): Promise<Partial<State>> {
    const standDownResult = (reason: string): Partial<State> => ({
      decision: { action: 'stand_down', amountWei: '0', reason },
      route: 'stand_down',
    });
    if (state.policy.revoked) return standDownResult('account revoked since sense — not signing');
    const rail = deps.signingRail;
    if (!rail) return standDownResult('sign requested but no signing rail configured — standing down');
    const descriptorId = decision.descriptorId ?? -1;
    const descriptor = rail.registry.get(descriptorId);
    const grant = await rail.loadGrant(ctx.agentId);
    const nowSec = Math.floor(Date.now() / 1000);

    // Unknown descriptor → the default-deny floor (never inferred — 00 §9). Narrow here so the rest
    // of the node works on a defined descriptor.
    if (!descriptor) return standDownResult('signing forbidden (unknown_descriptor)');
    const rule = grant.rules.get(descriptorId);

    // never-guess-money: build FIRST (pins spender/deadline/owner/expiry from server state + grant),
    // so classify reads the SAME resolved authority the wall will (never raw model fields). The
    // non-role pins (nonce, Permit2 `token`) come from the server-side resolver, never the model.
    const pins = await rail.resolvePins({ agentId: ctx.agentId, descriptorId });
    const built = buildIntent(descriptor, rule, {
      amountWei: decision.amountWei,
      ...(decision.signSpender !== undefined ? { spender: decision.signSpender } : {}),
      ctx: { self: ctx.accountAddr, nowSec, windowSec: windowForGrant(grant, descriptorId), pins },
    });
    // classify reads the resolved spender/amount/deadline (forbidden on malformed; L1/L2/L3 otherwise).
    const classification = classifySigning(
      {
        descriptorId,
        spender: built.ok ? built.spender : (decision.signSpender ?? ''),
        amountWei: decision.amountWei,
        deadlineSec: built.ok ? built.deadlineSec : nowSec + 1,
      },
      descriptor,
      grant,
      nowSec,
    );

    if (classification.lane === 'forbidden') return standDownResult(`signing forbidden (${classification.reason})`);
    if (classification.lane === 'l3_widen') {
      return standDownResult(`signing needs an owner grant-widen (${classification.reasons.join(', ')}) — standing down`);
    }
    // from here the intent must have built (L1/L2 require an in-grant descriptor + resolvable spender).
    if (!built.ok) return standDownResult(`signing intent not authority-determined (${built.reason})`);
    if (!rule) return standDownResult('signing intent has no standing grant — standing down');

    if (classification.lane === 'l2') {
      // sensitive → owner consents per-sign; quarantine on the JIT rail (armed on consent, FP-2 path).
      const requestHash = computeSigningRequestHash(
        descriptor.domain.chainId,
        descriptorId,
        built.spender,
        built.amountWei,
        built.deadlineSec,
      );
      const intent: Json = { descriptorId, fields: built.fields, digest: built.digest };
      await raiseSigningRequest(rail.service, ctx.agentRow, {
        descriptorId,
        triggers: classification.triggers,
        requestHash,
        humanReadable: built.humanReadable, // D-FP2-6: server-derived, never agent text
        protocol: descriptor.protocol,
        spender: built.spender,
        amountWei: built.amountWei,
        deadlineSec: built.deadlineSec,
        token: rule.token,
        maxDeadlineWindow: rule.maxDeadlineWindow,
        intent,
      });
      return standDownResult('sensitive signing — raised a JIT request for owner consent');
    }

    // L1 — in policy; arm it (session-key submit) via signAct.
    return {
      decision,
      route: 'sign',
      signDescriptorId: descriptorId,
      signFields: built.fields,
      signDigest: built.digest,
      signSpender: built.spender,
      signAmountWei: built.amountWei,
      signDeadlineSec: built.deadlineSec,
    };
  }

  /**
   * FP-3 — arm an L1 signing intent on-chain via the scoped session key, then record the arm in the
   * `signing_arms` read-model (status=armed, epoch snapshot). Symmetric with `callAct`: a revert is a
   * genuine boundary hit (recorded failed, never a phantom arm). The on-chain V5 wall re-validates +
   * debits the shared budget regardless — this submit never originates authority.
   */
  async function signAct(state: State): Promise<Partial<State>> {
    if (!deps.chain.authorizeSigningIntent) {
      return { outcome: { type: 'stood_down', reason: 'signing arm unsupported on this runtime chain' } };
    }
    try {
      const armed = await deps.chain.authorizeSigningIntent({
        sessionPrivateKey: ctx.sessionPrivateKey,
        accountAddr: ctx.accountAddr,
        descriptorId: state.signDescriptorId,
        fields: state.signFields,
        digest: state.signDigest,
      });
      await recordSigningArm(deps.pool, {
        agentId: ctx.agentId,
        descriptorId: state.signDescriptorId,
        digest: armed.digest,
        spender: state.signSpender,
        amount: state.signAmountWei,
        deadline: state.signDeadlineSec,
        epoch: armed.epoch,
      });
      return { outcome: { type: 'signed', digest: armed.digest, descriptorId: state.signDescriptorId } };
    } catch (err) {
      const decoded = decodeLeashError(err);
      const reason = decoded
        ? `signing arm refused: ${decoded.plain}`
        : `signing arm failed: ${err instanceof Error ? err.message : String(err)}`;
      return { outcome: { type: 'failed', reason, ...(decoded ? { decoded } : {}) } };
    }
  }

  async function requestApproval(state: State): Promise<Partial<State>> {
    // Pauses here; the manager persists the consent record BEFORE resuming.
    const resume = interrupt<Json, ApprovalDecision>({
      approvalId: state.approvalId,
      to: state.effectiveBeneficiary,
      valueWei: state.decision.amountWei,
    });
    if (resume.decision !== 'approve') {
      return { outcome: { type: 'denied', reason: resume.reason ?? 'denied by owner' } };
    }
    const outcome = await transfer(state, state.effectiveBeneficiary, state.decision.amountWei);
    return { outcome: outcome.type === 'acted' ? { ...outcome, approved: true } : outcome };
  }

  /**
   * NEW node (spec §3b): a warranted sentinel send becomes an envelope. Link
   * resolution, validation, and channel throttles ALL live in the coordinator
   * — a CoordinationError is a traced, non-crashing outcome (the coordinator
   * already traced the 'error'; record adds the 'decision'). The 'delegate'
   * trace itself is appended by the coordinator (no double-trace here).
   */
  async function delegate(state: State): Promise<Partial<State>> {
    const c = coordinator();
    if (!c) {
      return { outcome: { type: 'failed', reason: 'delegation rejected: coordinator unavailable' } };
    }
    try {
      const d = await c.issueDelegation({
        fromAgent: ctx.agentRow,
        kind: 'transfer.request',
        payload: {
          beneficiary: state.effectiveBeneficiary,
          amountWei: state.decision.amountWei,
          rationale: state.decision.reason,
        },
      });
      return { outcome: { type: 'delegated', delegationId: d.id } };
    } catch (err) {
      if (err instanceof CoordinationError) {
        return { outcome: { type: 'failed', reason: `delegation rejected: ${err.reason}` } };
      }
      throw err; // infra failure — the manager's cycle-failure path traces it
    }
  }

  async function standDown(state: State): Promise<Partial<State>> {
    return { outcome: { type: 'stood_down', reason: state.decision.reason } };
  }

  async function record(state: State): Promise<Partial<State>> {
    const o = state.outcome;
    if (o.type !== 'delegated') {
      // 'delegated' writes nothing here: the coordinator's 'delegate' trace IS
      // the issuer-side record of this outcome (spec §3b — no double-trace).
      //
      // AQ-A0-Q2VIS D-5 / D-4 audit layer: the hash-chained trace record is THE auditable record,
      // so this is where the deliberation is preserved whole (16 384 cap = p100 of 270 measured
      // healthy bodies + headroom; degenerate cycles store a signature instead of their
      // repetition — see `clipDeliberation`). `decisionSource` rides along as the durable G-6
      // scavenge counter: the scavenge rate is now a SQL question over this column, not a guess.
      const auditDetail: Record<string, Json> = state.deliberation
        ? { deliberation: state.deliberation, decisionSource: state.decisionSource, deliberationLoops: state.deliberationLoops, ...(state.finishReason ? { finishReason: state.finishReason } : {}) }
        : {};
      // D-4 owner layer: the rationale plus the verdict of the deterministic anchor check. BOTH are
      // stored — a rationale that failed the anchor is withheld from the surface (see
      // `traceEvent`) but kept here, because "the agent explained itself wrongly" is exactly the
      // kind of thing an audit record must not quietly drop.
      const anchor = state.decision?.rationale ? rationaleAnchored(state.decision) : null;
      if (state.decision?.rationale && anchor) {
        auditDetail['rationale'] = state.decision.rationale;
        auditDetail['rationaleAnchored'] = anchor.ok;
        if (!anchor.ok) {
          auditDetail['rationaleAnchorFailure'] = anchor.actionMatches ? 'amount' : 'action';
        }
      }
      // AQ-A1 D-1/D-2: persist this cycle's snapshot + boundary instruments under `detail.cycle`, so
      // the NEXT cycle's `loadCycleMemory` can read the last decision/outcome and diff balances. Only
      // when a snapshot was actually sensed (idle/reject cycles carry none — persisting one would
      // corrupt the next delta). `classifyOutcome` reduces the runtime's full outcome union to the
      // carry's legible vocabulary; the raw amount comes from the DECISION (what was attempted).
      if (state.senseSnapshot && state.decision) {
        const cycle: CycleRecord = {
          action: state.decision.action,
          amountWei: state.decision.amountWei,
          outcome: classifyOutcome(o.type, 'reason' in o ? o.reason : undefined, PARSE_MISS_REASON),
          actionPossible: state.actionPossible,
          observedChange: state.observedChange,
          promptTokens: state.promptTokens ?? null,
          snapshot: state.senseSnapshot,
        };
        auditDetail['cycle'] = cycle as unknown as Json;
      }
      // Beta step 3b: record WHICH asset an action moved (digest buckets by it) and label the amount
      // from the token's own decimals/symbol (null meta => honest "<n> units", never a guessed scale).
      const actedToken = o.type === 'acted' && o.token ? o.token : null;
      const actedMeta = actedToken ? await deps.chain.getErc20Meta(actedToken).catch(() => null) : null;
      const rec =
        o.type === 'acted'
          ? await appendTrace(deps.pool, {
              agentId: ctx.agentId,
              kind: 'action',
              ...(state.approvalId ? { approvalId: state.approvalId } : {}),
              detail: {
                to: o.callTarget ?? state.effectiveBeneficiary,
                valueWei: o.valueWei,
                txHash: o.txHash,
                ...(actedToken
                  ? {
                      token: actedToken.toLowerCase(),
                      ...(actedMeta ? { tokenSymbol: actedMeta.symbol, tokenDecimals: actedMeta.decimals } : {}),
                    }
                  : {}),
                // Q5 (presentation): human-legible amount (0G) + short address, not raw wei.
                summary: o.gasBought
                  ? o.gasBought
                  : o.callTarget
                  ? `governed call to ${shortAddr(o.callTarget)}${o.valueWei !== '0' ? ` (${formatG(o.valueWei)})` : ''}`
                  : o.token
                    ? `topped up ${shortAddr(state.effectiveBeneficiary)} with ${formatAssetAmount(o.valueWei, actedMeta?.decimals ?? null, actedMeta?.symbol ?? shortAddr(o.token))}`
                    : `sent ${formatG(o.valueWei)} to ${shortAddr(state.effectiveBeneficiary)}${o.approved ? ' (owner-approved)' : ''}`,
                // Q5: carry the model's own plain-language WHY so the cockpit shows why it acted.
                ...(state.decision?.reason ? { reason: state.decision.reason } : {}),
                ...auditDetail,
              },
            })
          : await appendTrace(deps.pool, {
              agentId: ctx.agentId,
              kind: 'decision',
              detail: {
                summary: outcomeSummary(o),
                reason: 'reason' in o ? o.reason : '',
                // P3C-6(ii): decoded contract error rides the trace detail.
                ...(o.type === 'failed' && o.decoded ? { decoded: { ...o.decoded } as unknown as Json } : {}),
                ...auditDetail,
              },
            });
      deps.hub.emit(ctx.agentId, 'trace', traceEvent(rec));
    }
    // Phase-5.5 working memory (spec §5, S23): accrue a salient, QUARANTINED-
    // UNTRUSTED finding whenever the agent actually reasoned this cycle (idle /
    // rejected-inbound cycles have empty reasoning and are skipped). Bounded
    // rolling window; the status summary reads it read-only, never as authority.
    //
    // AQ-A0-Q2VIS D-5 — this 2 000-char bound STAYS, deliberately. The spec named this line (and
    // the chain.handoff one below) as the persistence cap to raise to 16 384, but both are
    // PROMPT-BOUND channels, not the audit record: `direction/status.ts` reads 50 of these entries
    // straight into a model call, so a 16 KB cap here is ~800 KB of prompt per status question —
    // a cost regression, and the opposite of G-4. The audit fidelity D-5 actually asks for lives on
    // the hash-chained trace record above, which is what S-12 means by "the auditable trace
    // record". `state.reasoning` here is the short decision channel anyway, so this cap has never
    // been what truncated a deliberation.
    if (state.reasoning && state.reasoning.trim()) {
      await appendMemory(deps.pool, {
        agentId: ctx.agentId,
        kind: o.type,
        content: {
          summary:
            o.type === 'acted'
              ? o.gasBought
                ? o.gasBought
                : o.callTarget
                ? `governed call to ${shortAddr(o.callTarget)}`
                : o.token
                  ? `topped up ${shortAddr(state.effectiveBeneficiary)} in ${shortAddr(o.token)}`
                  : `sent ${formatG(o.valueWei)} to ${shortAddr(state.effectiveBeneficiary)}`
              : outcomeSummary(o),
          reasoning: state.reasoning.slice(0, 2000),
        },
      });
    }
    // Phase-5.5 lifespan dial (D-10): a task-scoped watcher whose goal is met
    // PROPOSES wind-down — a quarantined, deduped INFO suggestion, never forced.
    // Only the owner's wind-down confirm (POST /wind-down) stops the loop.
    const role = ctx.goal.type ?? 'treasury';
    if (
      deps.alerts &&
      o.type === 'stood_down' &&
      'reason' in o &&
      /target balance already met/i.test(o.reason) &&
      (role === 'treasury' || role === 'sentinel')
    ) {
      await deps.alerts.emit(ctx.agentRow.ownerAddr, {
        agentId: ctx.agentId,
        class: 'info',
        kind: 'wind_down_proposed',
        summary: `${ctx.agentRow.name} reports its goal is met — you can wind it down (mark done) or leave it running.`,
        refs: {},
        dedupKey: `wind_down_proposed:${ctx.agentId}`,
      });
    }
    await postInboundOutcome(state);
    return {};
  }

  /**
   * Outcome posting for an inbound delegation (spec §3b state machine,
   * accepted → completed|failed): the coordinator traces 'delegation_update'
   * on this agent's chain in each mark*. Receiver-side refusals AFTER
   * acceptance are 'failed', never 'declined' (we markAccepted before
   * reasoning — spec §4 keeps that). Every mark* is a compare-and-set: a null
   * return means another writer (e.g. revoke fan-out) already settled the row.
   */
  async function postInboundOutcome(state: State): Promise<void> {
    const inbound = state.inboundDelegation;
    if (!inbound) return;
    const c = coordinator();
    if (!c) return;
    const o = state.outcome;
    // F-4: a parse miss is a mechanical failure, never a verdict — requeue the
    // envelope (accepted → pending) so the next cycle re-reasons it instead of
    // burning the owner's approval. Pickup-time expiry stays the TTL backstop.
    if (o.type === 'stood_down' && o.reason === PARSE_MISS_REASON) {
      await c.markRequeued(inbound.delegationId);
      return;
    }
    // Phase 5.6 chain hop: the downstream COMPLETING its re-reasoning is a
    // success even when it stands down (an analyst "completes" by producing
    // analysis + not spending) — so the chain advances carrying the
    // downstream's OWN output. Only an owner-deny / hard failure / rejected
    // envelope terminates the chain. The output rides `result.output` for
    // onHopSettled (the next hop's labeled-untrusted upstreamOutput).
    if (inbound.kind === 'chain.handoff') {
      if (o.type === 'denied') {
        await c.markFailed(inbound.delegationId, 'owner denied');
      } else if (o.type === 'failed') {
        await c.markFailed(inbound.delegationId, o.reason);
      } else if (state.inboundReject) {
        await c.markFailed(inbound.delegationId, state.inboundReject);
      } else {
        await c.markCompleted(inbound.delegationId, {
          output: {
            outcome: o.type,
            ...(o.type === 'acted' ? { txHash: o.txHash, valueWei: o.valueWei } : {}),
            ...(o.type === 'delegated' ? { delegationId: o.delegationId } : {}),
            ...(state.reasoning ? { reasoning: state.reasoning.slice(0, 2000) } : {}),
          },
        });
      }
      return;
    }
    if (o.type === 'acted') {
      await c.markCompleted(inbound.delegationId, { txHash: o.txHash });
    } else if (state.inboundReject) {
      await c.markFailed(inbound.delegationId, state.inboundReject);
    } else if (o.type === 'denied') {
      await c.markFailed(inbound.delegationId, 'owner denied');
    } else if (o.type === 'failed') {
      await c.markFailed(inbound.delegationId, o.reason);
    } else if (o.type === 'stood_down') {
      await c.markFailed(inbound.delegationId, `receiver stood down: ${o.reason}`);
    }
  }

  /**
   * P3C-6(iii): record the active boundary + emit EXACTLY ONE limit_hit
   * decision alert per activation (DB-deduped by the boundary key). limit_hit
   * is explicitly NOT approvable — the contract reverts regardless; the
   * actionable path is adjust (policy panel) or dismiss.
   */
  async function activateBoundary(state: State, errorName: DampableError, clearsAtUnix: number | null): Promise<void> {
    if (!deps.boundaries) return;
    const boundaryId = clearsAtUnix !== null ? String(clearsAtUnix) : policyFingerprint(state.policy).slice(0, 16);
    const dedupKey = `limit_hit:${ctx.agentId}:${errorName}:${boundaryId}`;
    const already = deps.boundaries.get(ctx.agentId);
    if (already && already.dedupKey === dedupKey) return; // same boundary, already alerted
    const nowSec = Math.floor(Date.now() / 1000);
    deps.boundaries.set(ctx.agentId, {
      errorName,
      clearsAtUnix,
      policyFingerprint: policyFingerprint(state.policy),
      dedupKey,
      activatedAtUnix: nowSec,
    });
    if (deps.alerts) {
      const resetsIn = clearsAtUnix !== null ? Math.max(0, Math.round((clearsAtUnix - nowSec) / 60)) : null;
      const summary =
        errorName === 'OverWindowCap'
          ? `${ctx.agentRow.name} hit its spending window cap — ${resetsIn !== null ? `resets in ${resetsIn} min` : 'raise the cap or wait'}. Approving cannot override this; adjust the policy if it is too tight.`
          : errorName === 'OverPerTransferCap'
            ? `${ctx.agentRow.name} keeps proposing transfers over its per-transfer cap. Adjust the cap if it is too tight.`
            : errorName === 'SessionExpired'
              ? `${ctx.agentRow.name}'s session expired — re-arm it to let it act again.`
              : `${ctx.agentRow.name} tried to pay an address that is not on its allowlist.`;
      await deps.alerts.emit(ctx.agentRow.ownerAddr, {
        agentId: ctx.agentId,
        class: 'decision',
        kind: 'limit_hit',
        summary,
        refs: {
          errorName,
          ...(clearsAtUnix !== null ? { boundaryClearsAtUnix: clearsAtUnix } : {}),
        },
        dedupKey,
      });
    }
  }

  async function transfer(state: State, to: string, amountWei: string): Promise<CycleOutcome> {
    try {
      const { txHash } = await deps.chain.executeTransfer({
        sessionPrivateKey: ctx.sessionPrivateKey,
        accountAddr: ctx.accountAddr,
        to,
        valueWei: BigInt(amountWei),
      });
      return { type: 'acted', txHash, valueWei: amountWei };
    } catch (err) {
      // The contract refused (window cap, revoke racing, ...) — record, don't
      // crash. P3C-6(ii): decode the custom error into plain language; (iii):
      // a policy-boundary revert activates damping.
      const decoded = decodeLeashError(err);
      if (decoded && (DAMPABLE_ERRORS as readonly string[]).includes(decoded.errorName)) {
        const clearsAt =
          decoded.errorName === 'OverWindowCap' ? state.policy.windowResetsAtUnix : null;
        await activateBoundary(state, decoded.errorName as DampableError, clearsAt);
      }
      const reason = decoded
        ? `execute refused: ${decoded.plain}`
        : `execute failed: ${err instanceof Error ? err.message : String(err)}`;
      return { type: 'failed', reason, ...(decoded ? { decoded } : {}) };
    }
  }

  return new StateGraph(TreasuryState)
    .addNode('sense_direction', senseDirection)
    .addNode('sense', sense)
    .addNode('reason', reason)
    .addNode('decide', decide)
    .addNode('act', act)
    .addNode('tokenAct', tokenAct)
    .addNode('gasSwapAct', gasSwapAct)
    .addNode('gasBridgeAct', gasBridgeAct)
    .addNode('callAct', callAct)
    .addNode('toolAct', toolAct)
    .addNode('signAct', signAct)
    .addNode('requestApproval', requestApproval)
    .addNode('delegate', delegate)
    .addNode('standDown', standDown)
    .addNode('record', record)
    .addEdge(START, 'sense_direction')
    .addEdge('sense_direction', 'sense')
    .addEdge('sense', 'reason')
    .addEdge('reason', 'decide')
    .addConditionalEdges('decide', (state: State) => state.route, {
      act: 'act',
      token_act: 'tokenAct',
      gas_swap: 'gasSwapAct',
      gas_bridge: 'gasBridgeAct',
      call: 'callAct',
      tool_call: 'toolAct',
      sign: 'signAct',
      approval: 'requestApproval',
      delegate: 'delegate',
      stand_down: 'standDown',
    })
    .addEdge('act', 'record')
    .addEdge('tokenAct', 'record')
    .addEdge('gasSwapAct', 'record')
    .addEdge('gasBridgeAct', 'record')
    .addEdge('callAct', 'record')
    .addEdge('toolAct', 'record')
    .addEdge('signAct', 'record')
    .addEdge('requestApproval', 'record')
    .addEdge('delegate', 'record')
    .addEdge('standDown', 'record')
    .addEdge('record', END)
    .compile({ checkpointer });
}

export type TreasuryGraph = ReturnType<typeof buildTreasuryGraph>;

/**
 * F-4: the one stand-down reason that is a MECHANICAL failure (unreadable model
 * output), not a reasoned refusal — the inbound-outcome poster requeues on it
 * instead of terminally failing an accepted envelope.
 */
export const PARSE_MISS_REASON = 'model output was not a valid decision';

/**
 * Deterministic policy overlay on the model's decision. The LLM proposes;
 * this disposes — per role (spec §3b):
 * - treasury: Phase-1 behavior unchanged (act | approval | stand_down).
 * - sentinel: a warranted send becomes route 'delegate' — NEVER 'act', NEVER
 *   'approval' (the executor's policy + approval boundary govern the spend).
 * - executor: autonomous cycles always stand down ('executor is
 *   delegation-driven'); inbound 'transfer.request' flows the NORMAL overlay
 *   against the executor's OWN policy (delegations carry zero authority).
 */
function evaluateDecision(
  state: State,
  ctx: TreasuryAgentContext,
): { decision: AgentDecision; route: Route; inboundReject?: string } {
  const stand = (reason: string): { decision: AgentDecision; route: Route } => ({
    decision: { action: 'stand_down', amountWei: '0', reason },
    route: 'stand_down',
  });

  const mode = classifyCycle(ctx.goal, state.inboundDelegation);
  if (mode.mode === 'executor_idle') return stand('executor is delegation-driven');
  if (mode.mode === 'inbound_reject') {
    // Verbatim markFailed reason (spec §3b) — record maps it 1:1, distinct
    // from an executor's own post-reasoning stand-down.
    return { ...stand(mode.reason), inboundReject: mode.reason };
  }

  const parsed = parseDecision(state.reasoning);
  if (!parsed) return stand(PARSE_MISS_REASON);
  if (parsed.action === 'stand_down') {
    return { decision: parsed, route: 'stand_down' };
  }

  // Stage D (D-10): a governed call. Deterministic pre-checks here; the async
  // grant-state classify + never-guess-money build happens in the decide node.
  if (parsed.action === 'call') {
    const role = ctx.goal.type ?? 'treasury';
    if (role !== 'treasury' && role !== 'trader') {
      return stand('governed calls are only for the treasury and trader roles');
    }
    if (!parsed.target || !parsed.selector) return stand('call decision missing target/selector');
    if (state.policy.revoked) return stand('account is revoked');
    if (state.policy.expiresAt <= Math.floor(Date.now() / 1000)) return stand('session expired');
    // FR3 (F-8): deterministic trader bounds — the model's ladder is advisory;
    // target-met and the per-trade clip are re-checked here (never-guess-money:
    // the clip is the owner-typed goal bound, on-chain caps bound again).
    if (ctx.goal.type === 'trader') {
      if (state.holdings && BigInt(state.holdings.holdBalanceWei) >= BigInt(ctx.goal.targetHoldWei)) {
        return stand('hold-token target already met');
      }
      if (BigInt(parsed.amountWei) > BigInt(ctx.goal.clipWei)) {
        return stand('proposed amount exceeds the per-trade clip');
      }
    }
    return { decision: parsed, route: 'call' };
  }

  // SF-3 (STAGE-F §3b): a governed tool call. Deterministic pre-checks here; the
  // grant-state classify + I/O guard happen in the decide node (never-trust-model).
  if (parsed.action === 'tool_call') {
    if (!parsed.toolId) return stand('tool_call decision missing toolId');
    if (state.policy.revoked) return stand('account is revoked');
    return { decision: parsed, route: 'tool_call' };
  }

  // FP-3 (STAGE-F-PRIME): a governed signing intent. Deterministic pre-checks here; the grant-state
  // classify + never-guess-money build happen in the decide node (never trust the model for authority).
  if (parsed.action === 'sign') {
    if (parsed.descriptorId === undefined) return stand('sign decision missing descriptorId');
    if (state.policy.revoked) return stand('account is revoked');
    if (state.policy.expiresAt <= Math.floor(Date.now() / 1000)) return stand('session expired');
    return { decision: parsed, route: 'sign' };
  }

  // FR3 (F-8): the trader NEVER sends native transfers — a 'send' from it is a
  // model error (or an injected instruction); refuse deterministically.
  if (ctx.goal.type === 'trader') return stand('trader never sends native transfers');

  const amount = BigInt(parsed.amountWei);
  if (amount <= 0n) return stand('non-positive transfer amount');
  const policy = state.policy;
  if (policy.revoked) return stand('account is revoked');

  if (ctx.goal.type === 'sentinel') {
    // Sentinel never touches its own (spend-incapable) policy caps or
    // allowlist — the request is bounded by the EXECUTOR's policy on receipt.
    // Target-met stays deterministic: no envelope when nothing is warranted.
    if (BigInt(state.beneficiaryBalanceWei) >= BigInt(ctx.goal.targetBalanceWei)) {
      return stand('target balance already met');
    }
    return { decision: parsed, route: 'delegate' };
  }

  // AQ-FND M-3: a token-denominated treasury goal keeps the beneficiary topped up in
  // an ERC-20 instead of native 0G. target/topUp are the token's base units; the
  // target-met check reads the beneficiary's TOKEN balance (never-guess-money: the
  // token + beneficiary are the owner-typed goal, server-read on-chain). The per-token
  // payee allowlist + spendability + the gas ladder are resolved async in the decide
  // node (mirrors the governed-call path) — not here, so native behaviour is untouched.
  {
    const autoGoalTok = autonomousGoalOf(mode);
    const token = treasuryGoalToken(autoGoalTok);
    if (token && autoGoalTok && 'targetBalanceWei' in autoGoalTok) {
      const nowTok = Math.floor(Date.now() / 1000);
      if (policy.expiresAt <= nowTok) return stand('session expired');
      if (BigInt(state.beneficiaryTokenBalanceWei) >= BigInt(autoGoalTok.targetBalanceWei)) {
        return stand('token target balance already met');
      }
      return { decision: parsed, route: 'token_act' };
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (policy.expiresAt <= nowSec) return stand('session expired');
  if (!policy.allowlist.includes(state.effectiveBeneficiary.toLowerCase())) {
    return stand('beneficiary is not allowlisted');
  }
  const autoGoal = autonomousGoalOf(mode);
  if (autoGoal && 'targetBalanceWei' in autoGoal) {
    // Treasury/sentinel (incl. a re-reasoned chain hop) target check — an
    // inbound transfer.request has no goal target; the executor honours the
    // request bounded by its policy instead. (Trader already returned above.)
    if (BigInt(state.beneficiaryBalanceWei) >= BigInt(autoGoal.targetBalanceWei)) {
      return stand('target balance already met');
    }
  }
  if (amount > BigInt(state.accountBalanceWei)) return stand('insufficient account balance');

  const route: Route = amount > BigInt(policy.perTransferCapWei) ? 'approval' : 'act';
  return { decision: parsed, route };
}

/**
 * AQ-A0-Q2VIS D-5 — the deliberation fidelity floor.
 *
 * The old cap was `slice(0, 2000)`, which fully preserves 6 of 270 measured healthy deliberations
 * (2.2%) — the auditable record was mutilated on 97.8% of cycles. The cap is not a storage dial,
 * it is a fidelity floor, so it is set from the measured distribution rather than guessed: p100 of
 * 270 healthy bodies is 13 818 chars, and 16 384 covers that with headroom while staying aligned to
 * `max_tokens: 4096` at ~4 chars/token. Measured healthy retention: 100%.
 *
 * The truncated population is a genuinely DIFFERENT distribution (up to 64 254 chars of the same
 * sentence restated), so a cap alone cannot serve both — a degenerate cycle stores its SIGNATURE
 * instead of its repetition.
 *
 * Note which signal decides that. `loop_count` was the SCOPE chat's candidate, measured on 16
 * bodies; re-measured on 200 it does NOT separate (healthy reaches 14, degenerate starts at 6).
 * `finish_reason: 'length'` separates perfectly at n=200 — every truncated cycle sat exactly at the
 * 4 096-token cap, every healthy one at or below 3 538 — so that is the classifier, and loop_count
 * is recorded as severity.
 *
 * Storage: mean 4 741 chars x 2 880 cycles/day ≈ 13.6 MB/day/agent. If that ever bites, it is
 * solved at the retention/compression layer — never by truncating every record at ingest.
 */
const DELIBERATION_CAP = 16_384;

/**
 * AQ-A1 D-3: the per-cycle INPUT token ceiling. A HARD budget, never a clip point — a breach is
 * alerted and the full prompt still goes (a truncated money-decision prompt is the worse failure).
 * 4 096 matches the completion budget; current roles sit at ~1.2–1.7k and D-1 adds ≤~0.6k, so a
 * breach means the composition grew wrong (unbounded capabilities/allowlist) and wants investigation.
 */
const INPUT_TOKEN_CEILING = 4_096;

/**
 * AQ-A1 D-1 carry gate. The carry's instrument (D-2) + budget (D-3) are always-on; this governs
 * whether the carry is INJECTED into the prompt. Round 1 forced it off (the PROSE carry truncated
 * 40–52% — a G-1 fail). Round 2 (`M-memory-matrix-round2.json`) proved the FLAG-shaped carry clears
 * G-1 (0/60 truncation, parse 100%, completion tokens BELOW the memoryless baseline) and G-2 (100%
 * flip-correct, 100% do-no-harm) — so it now ships: default ON, injected as `cycleFlags` (never the
 * prose block). The env override `AQ_A1_CARRY=0` disables it for a live A-B or rollback without a
 * code change. A `main` merge still gates on Gate-② AGREE + ⑥, independent of this default.
 */
const CARRY_INJECTION_ENABLED = process.env.AQ_A1_CARRY !== '0';

export function clipDeliberation(
  deliberation: string,
  health: { finishReason: string | null; loopCount: number },
): { text: string; clipped: boolean } {
  if (health.finishReason === 'length') {
    // Degenerate: keep what identifies the failure (head + tail + the numbers), not the loop.
    const head = deliberation.slice(0, 1_000);
    const tail = deliberation.slice(-1_000);
    return {
      text:
        `[degenerate cycle: the model restated its answer ${health.loopCount}x until it hit the token cap ` +
        `(finish_reason=length, ${deliberation.length} chars). Head and tail kept; the repetition is not stored.]\n` +
        `--- head ---\n${head}\n--- tail ---\n${tail}`,
      clipped: true,
    };
  }
  if (deliberation.length <= DELIBERATION_CAP) return { text: deliberation, clipped: false };
  return { text: deliberation.slice(0, DELIBERATION_CAP), clipped: true };
}

function outcomeSummary(o: CycleOutcome): string {
  switch (o.type) {
    case 'stood_down':
      return `stood down: ${o.reason}`;
    case 'denied':
      return `owner denied the transfer: ${o.reason}`;
    case 'failed':
      return o.reason;
    case 'tool_used':
      return o.isError ? `tool ${o.toolId} returned an error` : `used tool ${o.toolId}`;
    case 'signed':
      return `armed a governed signing intent (descriptor ${o.descriptorId})`;
    case 'signing_requested':
      return `raised a JIT signing request for owner consent (descriptor ${o.descriptorId})`;
    default:
      return 'cycle complete';
  }
}
