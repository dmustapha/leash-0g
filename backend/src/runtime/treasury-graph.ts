import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalDecision } from '../approvals/broker.js';
import { createApproval } from '../store/approvals.js';
import { appendTrace } from '../trace/trace-store.js';
import { approvalEvent, reasoningEvent, traceEvent } from '../sse/events.js';
import type { Json } from '../crypto/canonical.js';
import type { AgentGoal, AgentRow, SentinelGoal, TreasuryGoal } from '../types.js';
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
import { loadGrantState } from './grant-state.js';
import { buildGovernedCall, BRIDGE_SELECTORS, SELECTORS } from '../governed-call/index.js';
import { classifyIntendedCall } from '../gateway/call-gate.js';
import { raiseCapabilityRequest, type CapabilityDeps } from '../capabilities/service.js';
import { listGrants } from '../store/capabilities.js';
import {
  buildReasonRequest,
  completionContent,
  parseDecision,
  type AgentDecision,
  type CapabilityView,
  type InboundDelegationInput,
  type PolicySnapshot,
} from './prompt.js';

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
  | { type: 'acted'; txHash: string; valueWei: string; approved?: boolean; callTarget?: string }
  | { type: 'delegated'; delegationId: string }
  | { type: 'stood_down'; reason: string }
  | { type: 'denied'; reason: string }
  | { type: 'failed'; reason: string; decoded?: DecodedLeashError };

type Route = 'act' | 'approval' | 'delegate' | 'call' | 'stand_down';

const TreasuryState = Annotation.Root({
  /** Set by the manager when this cycle processes an inbound delegation (spec §3b). */
  inboundDelegation: Annotation<InboundDelegationInput | null>,
  beneficiaryBalanceWei: Annotation<string>,
  accountBalanceWei: Annotation<string>,
  /** Transfer target this cycle: goal beneficiary, or the inbound request's. */
  effectiveBeneficiary: Annotation<string>,
  policy: Annotation<PolicySnapshot>,
  /** Stage D (D-10): the governed calls this agent may make this cycle (serializable). */
  capabilities: Annotation<CapabilityView[]>,
  reasoning: Annotation<string>,
  decision: Annotation<AgentDecision>,
  route: Annotation<Route>,
  /** Stage D (D-10): the resolved governed-call `executeCall` args for the `call` route. */
  callTarget: Annotation<string>,
  callData: Annotation<string>,
  callValue: Annotation<string>,
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
        assertRoutable: (bridgeTarget: string) => Promise<{ destinationChainId: number; verifiedAddr: string }>;
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
  | { mode: 'autonomous'; goal: TreasuryGoal | SentinelGoal }
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
    if (isLegacyAutonomous) return { mode: 'autonomous', goal: goal as TreasuryGoal | SentinelGoal };
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
function autonomousGoalOf(mode: CycleMode): TreasuryGoal | SentinelGoal | null {
  if (mode.mode === 'autonomous' || mode.mode === 'inbound_chain') return mode.goal;
  return null;
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
    if (role !== 'treasury') return [];
    if (mode.mode !== 'autonomous' && mode.mode !== 'inbound_chain') return [];
    const grants = await listGrants(deps.pool, ctx.agentId);
    return grants.map((g) => ({
      target: g.target,
      selector: g.selector,
      signature: SELECTORS.get(g.selector.toLowerCase())?.signature ?? null,
      perCallCap: g.perCallCap,
    }));
  }

  async function sense(state: State): Promise<Partial<State>> {
    const mode = classifyCycle(ctx.goal, state.inboundDelegation);
    // No transfer intent this cycle (idle executor / rejected inbound): skip
    // the RPC reads — nothing downstream consults them, and the idle executor
    // polls forever (RPC burn for nothing).
    if (mode.mode === 'executor_idle' || mode.mode === 'inbound_reject') {
      return {
        beneficiaryBalanceWei: '0',
        accountBalanceWei: '0',
        effectiveBeneficiary: '',
        capabilities: [],
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
    const autoGoal = autonomousGoalOf(mode);
    const beneficiary = mode.mode === 'inbound_transfer' ? mode.request.beneficiary : (autoGoal?.beneficiary ?? '');
    const [beneficiaryBalance, account, policy, capabilities] = await Promise.all([
      deps.chain.getBalance(beneficiary),
      deps.chain.getBalance(ctx.accountAddr),
      deps.chain.getPolicyView(ctx.accountAddr, [beneficiary]),
      senseCapabilities(mode),
    ]);
    // P3C-6(i): window observability with the contract's OWN lazy-rollover
    // math (LeashAccount.execute) — past the boundary the window has
    // logically reset even though storage updates on the next spend.
    const nowSec = Math.floor(Date.now() / 1000);
    const resetsAt = policy.windowStart + policy.windowSeconds;
    const rolled = policy.windowSeconds > 0 && nowSec >= resetsAt;
    const spent = rolled ? 0n : policy.spentInWindow;
    const remaining = policy.windowCap > spent ? policy.windowCap - spent : 0n;
    return {
      beneficiaryBalanceWei: beneficiaryBalance.toString(),
      accountBalanceWei: account.toString(),
      effectiveBeneficiary: beneficiary,
      capabilities,
      policy: {
        perTransferCapWei: policy.perTransferCap.toString(),
        windowCapWei: policy.windowCap.toString(),
        windowSeconds: policy.windowSeconds,
        expiresAt: policy.expiresAt,
        allowlist: policy.allowlist.map((a) => a.toLowerCase()),
        revoked: policy.revoked,
        spentInWindowWei: spent.toString(),
        remainingWindowWei: remaining.toString(),
        // After a logical reset the NEXT window starts at the next spend —
        // report the boundary that already passed (FE copy clamps to "now").
        windowResetsAtUnix: rolled ? nowSec : resetsAt,
      },
    };
  }

  async function reason(state: State): Promise<Partial<State>> {
    const mode = classifyCycle(ctx.goal, state.inboundDelegation);
    // Idle executor / rejected inbound: no model call — the outcome is fully
    // deterministic, and reasoning over it would burn 0G Compute per poll
    // (resp. per spam envelope — the coordinator throttles bound issuance,
    // this bounds the receiver side).
    if (mode.mode === 'executor_idle' || mode.mode === 'inbound_reject') {
      return { reasoning: '' };
    }
    const model = ctx.goal.model ?? deps.defaultModel;
    const body = buildReasonRequest(model, {
      goal: ctx.goal,
      beneficiaryBalanceWei: state.beneficiaryBalanceWei,
      accountBalanceWei: state.accountBalanceWei,
      policy: state.policy,
      nowSec: Math.floor(Date.now() / 1000),
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
    let text = completionContent(completion);
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
          const retryText = completionContent(await retryRes.json().catch(() => null));
          if (parseDecision(retryText)) text = retryText;
        }
      } catch {
        /* keep the first output — the decide overlay stands down on it */
      }
    }
    deps.hub.emit(ctx.agentId, 'reasoning', reasoningEvent(text || '(empty model output)'));
    return { reasoning: text };
  }

  async function decide(state: State): Promise<Partial<State>> {
    const verdict = evaluateDecision(state, ctx);
    // Stage D (D-10): a governed call is classified against a LIVE grant-state
    // read (never native-transfer window damping — its caps live on-chain +
    // in classify). Resolve it BEFORE the transfer-damping block.
    if (verdict.route === 'call') return decideCall(state, verdict.decision);
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
        (autoGoal !== null && BigInt(state.beneficiaryBalanceWei) < BigInt(autoGoal.targetBalanceWei));
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
        summary: `agent wants to send ${verdict.decision.amountWei} wei (over per-transfer cap)`,
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
    const built = buildGovernedCall(
      { target: decision.target ?? '', selector: decision.selector ?? '', amountWei: decision.amountWei },
      grant,
      self,
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
          const routed = await deps.bridge.assertRoutable(built.target);
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
                summary: o.callTarget
                  ? `governed call to ${o.callTarget}${o.valueWei !== '0' ? ` (${o.valueWei} wei)` : ''}`
                  : `sent ${o.valueWei} wei to ${state.effectiveBeneficiary}${o.approved ? ' (owner-approved)' : ''}`,
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
              },
            });
      deps.hub.emit(ctx.agentId, 'trace', traceEvent(rec));
    }
    // Phase-5.5 working memory (spec §5, S23): accrue a salient, QUARANTINED-
    // UNTRUSTED finding whenever the agent actually reasoned this cycle (idle /
    // rejected-inbound cycles have empty reasoning and are skipped). Bounded
    // rolling window; the status summary reads it read-only, never as authority.
    if (state.reasoning && state.reasoning.trim()) {
      await appendMemory(deps.pool, {
        agentId: ctx.agentId,
        kind: o.type,
        content: {
          summary:
            o.type === 'acted'
              ? o.callTarget
                ? `governed call to ${o.callTarget}`
                : `sent ${o.valueWei} wei to ${state.effectiveBeneficiary}`
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
    .addNode('callAct', callAct)
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
      call: 'callAct',
      approval: 'requestApproval',
      delegate: 'delegate',
      stand_down: 'standDown',
    })
    .addEdge('act', 'record')
    .addEdge('callAct', 'record')
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
    if (role !== 'treasury') return stand('governed calls are only for the treasury role');
    if (!parsed.target || !parsed.selector) return stand('call decision missing target/selector');
    if (state.policy.revoked) return stand('account is revoked');
    if (state.policy.expiresAt <= Math.floor(Date.now() / 1000)) return stand('session expired');
    return { decision: parsed, route: 'call' };
  }

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

  const nowSec = Math.floor(Date.now() / 1000);
  if (policy.expiresAt <= nowSec) return stand('session expired');
  if (!policy.allowlist.includes(state.effectiveBeneficiary.toLowerCase())) {
    return stand('beneficiary is not allowlisted');
  }
  const autoGoal = autonomousGoalOf(mode);
  if (autoGoal) {
    // Treasury/sentinel (incl. a re-reasoned chain hop) target check — an
    // inbound transfer.request has no goal target; the executor honours the
    // request bounded by its policy instead.
    if (BigInt(state.beneficiaryBalanceWei) >= BigInt(autoGoal.targetBalanceWei)) {
      return stand('target balance already met');
    }
  }
  if (amount > BigInt(state.accountBalanceWei)) return stand('insufficient account balance');

  const route: Route = amount > BigInt(policy.perTransferCapWei) ? 'approval' : 'act';
  return { decision: parsed, route };
}

function outcomeSummary(o: CycleOutcome): string {
  switch (o.type) {
    case 'stood_down':
      return `stood down: ${o.reason}`;
    case 'denied':
      return `owner denied the transfer: ${o.reason}`;
    case 'failed':
      return o.reason;
    default:
      return 'cycle complete';
  }
}
