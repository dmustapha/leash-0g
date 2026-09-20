import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalDecision } from '../approvals/broker.js';
import { createApproval } from '../store/approvals.js';
import { appendTrace } from '../trace/trace-store.js';
import { approvalEvent, reasoningEvent, traceEvent } from '../sse/events.js';
import type { Json } from '../crypto/canonical.js';
import type { AgentGoal } from '../types.js';
import type { RuntimeChain } from './session-chain.js';
import {
  buildReasonRequest,
  completionContent,
  parseDecision,
  type AgentDecision,
  type PolicySnapshot,
} from './prompt.js';

/**
 * The treasury allowance agent (spec §3b): an explicit LangGraph with a
 * CONDITIONAL refusal edge (Phase-0 gate — no unconditional gate→act):
 *
 *   sense → reason (via the LEASH gateway) → decide
 *     → [act | request-approval (interrupt) | stand-down] → record
 *
 * The decide node re-validates the LLM's decision against on-chain policy
 * deterministically — model output is untrusted input, the contract is the
 * hard boundary. All state is JSON-serializable for the Postgres checkpointer.
 */

export type CycleOutcome =
  | { type: 'acted'; txHash: string; valueWei: string; approved?: boolean }
  | { type: 'stood_down'; reason: string }
  | { type: 'denied'; reason: string }
  | { type: 'failed'; reason: string };

type Route = 'act' | 'approval' | 'stand_down';

const TreasuryState = Annotation.Root({
  beneficiaryBalanceWei: Annotation<string>,
  accountBalanceWei: Annotation<string>,
  policy: Annotation<PolicySnapshot>,
  reasoning: Annotation<string>,
  decision: Annotation<AgentDecision>,
  route: Annotation<Route>,
  approvalId: Annotation<string>,
  outcome: Annotation<CycleOutcome>,
});

type State = typeof TreasuryState.State;

export interface TreasuryGraphDeps {
  pool: Pool;
  hub: SseHub;
  chain: RuntimeChain;
  gatewayUrl: string;
  defaultModel: string;
  fetchFn?: typeof fetch;
}

export interface TreasuryAgentContext {
  agentId: string;
  accountAddr: string;
  goal: AgentGoal;
  /** Scoped session key — the ONLY signing material the runtime holds. */
  sessionPrivateKey: string;
  gatewayToken: string;
}

export function buildTreasuryGraph(
  deps: TreasuryGraphDeps,
  ctx: TreasuryAgentContext,
  checkpointer: BaseCheckpointSaver,
) {
  const fetchFn = deps.fetchFn ?? fetch;

  async function sense(): Promise<Partial<State>> {
    const [beneficiary, account, policy] = await Promise.all([
      deps.chain.getBalance(ctx.goal.beneficiary),
      deps.chain.getBalance(ctx.accountAddr),
      deps.chain.getPolicyView(ctx.accountAddr, [ctx.goal.beneficiary]),
    ]);
    return {
      beneficiaryBalanceWei: beneficiary.toString(),
      accountBalanceWei: account.toString(),
      policy: {
        perTransferCapWei: policy.perTransferCap.toString(),
        windowCapWei: policy.windowCap.toString(),
        windowSeconds: policy.windowSeconds,
        expiresAt: policy.expiresAt,
        allowlist: policy.allowlist.map((a) => a.toLowerCase()),
        revoked: policy.revoked,
      },
    };
  }

  async function reason(state: State): Promise<Partial<State>> {
    const model = ctx.goal.model ?? deps.defaultModel;
    const body = buildReasonRequest(model, {
      goal: ctx.goal,
      beneficiaryBalanceWei: state.beneficiaryBalanceWei,
      accountBalanceWei: state.accountBalanceWei,
      policy: state.policy,
      nowSec: Math.floor(Date.now() / 1000),
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
    const text = completionContent(completion);
    deps.hub.emit(ctx.agentId, 'reasoning', reasoningEvent(text || '(empty model output)'));
    return { reasoning: text };
  }

  async function decide(state: State): Promise<Partial<State>> {
    const verdict = evaluateDecision(state, ctx);
    if (verdict.route !== 'approval') return verdict;
    // Side effects live HERE (a completed, checkpointed node) — the interrupt
    // node re-executes from its top on resume, which would duplicate rows.
    const approval = await createApproval(deps.pool, ctx.agentId, {
      kind: 'transfer',
      to: ctx.goal.beneficiary,
      valueWei: verdict.decision.amountWei,
      reason: verdict.decision.reason,
    });
    deps.hub.emit(
      ctx.agentId,
      'approval',
      approvalEvent({
        approvalId: approval.id,
        summary: `agent wants to send ${verdict.decision.amountWei} wei (over per-transfer cap)`,
        to: ctx.goal.beneficiary,
        valueWei: verdict.decision.amountWei,
      }),
    );
    return { ...verdict, approvalId: approval.id };
  }

  async function act(state: State): Promise<Partial<State>> {
    return { outcome: await transfer(state.decision.amountWei) };
  }

  async function requestApproval(state: State): Promise<Partial<State>> {
    // Pauses here; the manager persists the consent record BEFORE resuming.
    const resume = interrupt<Json, ApprovalDecision>({
      approvalId: state.approvalId,
      to: ctx.goal.beneficiary,
      valueWei: state.decision.amountWei,
    });
    if (resume.decision !== 'approve') {
      return { outcome: { type: 'denied', reason: resume.reason ?? 'denied by owner' } };
    }
    const outcome = await transfer(state.decision.amountWei);
    return { outcome: outcome.type === 'acted' ? { ...outcome, approved: true } : outcome };
  }

  async function standDown(state: State): Promise<Partial<State>> {
    return { outcome: { type: 'stood_down', reason: state.decision.reason } };
  }

  async function record(state: State): Promise<Partial<State>> {
    const o = state.outcome;
    const rec =
      o.type === 'acted'
        ? await appendTrace(deps.pool, {
            agentId: ctx.agentId,
            kind: 'action',
            ...(state.approvalId ? { approvalId: state.approvalId } : {}),
            detail: {
              to: ctx.goal.beneficiary,
              valueWei: o.valueWei,
              txHash: o.txHash,
              summary: `sent ${o.valueWei} wei to ${ctx.goal.beneficiary}${o.approved ? ' (owner-approved)' : ''}`,
            },
          })
        : await appendTrace(deps.pool, {
            agentId: ctx.agentId,
            kind: 'decision',
            detail: { summary: outcomeSummary(o), reason: o.reason },
          });
    deps.hub.emit(ctx.agentId, 'trace', traceEvent(rec));
    return {};
  }

  async function transfer(amountWei: string): Promise<CycleOutcome> {
    try {
      const { txHash } = await deps.chain.executeTransfer({
        sessionPrivateKey: ctx.sessionPrivateKey,
        accountAddr: ctx.accountAddr,
        to: ctx.goal.beneficiary,
        valueWei: BigInt(amountWei),
      });
      return { type: 'acted', txHash, valueWei: amountWei };
    } catch (err) {
      // The contract refused (window cap, revoke racing, ...) — record, don't crash.
      return { type: 'failed', reason: `execute failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return new StateGraph(TreasuryState)
    .addNode('sense', sense)
    .addNode('reason', reason)
    .addNode('decide', decide)
    .addNode('act', act)
    .addNode('requestApproval', requestApproval)
    .addNode('standDown', standDown)
    .addNode('record', record)
    .addEdge(START, 'sense')
    .addEdge('sense', 'reason')
    .addEdge('reason', 'decide')
    .addConditionalEdges('decide', (state: State) => state.route, {
      act: 'act',
      approval: 'requestApproval',
      stand_down: 'standDown',
    })
    .addEdge('act', 'record')
    .addEdge('requestApproval', 'record')
    .addEdge('standDown', 'record')
    .addEdge('record', END)
    .compile({ checkpointer });
}

export type TreasuryGraph = ReturnType<typeof buildTreasuryGraph>;

/**
 * Deterministic policy overlay on the model's decision. The LLM proposes;
 * this disposes: stand down on anything unparseable or out of policy, route
 * to owner approval when the proposal exceeds the per-transfer cap.
 */
function evaluateDecision(
  state: State,
  ctx: TreasuryAgentContext,
): { decision: AgentDecision; route: Route } {
  const stand = (reason: string): { decision: AgentDecision; route: Route } => ({
    decision: { action: 'stand_down', amountWei: '0', reason },
    route: 'stand_down',
  });

  const parsed = parseDecision(state.reasoning);
  if (!parsed) return stand('model output was not a valid decision');
  if (parsed.action === 'stand_down') {
    return { decision: parsed, route: 'stand_down' };
  }

  const policy = state.policy;
  const nowSec = Math.floor(Date.now() / 1000);
  const amount = BigInt(parsed.amountWei);
  if (amount <= 0n) return stand('non-positive transfer amount');
  if (policy.revoked) return stand('account is revoked');
  if (policy.expiresAt <= nowSec) return stand('session expired');
  if (!policy.allowlist.includes(ctx.goal.beneficiary.toLowerCase())) {
    return stand('beneficiary is not allowlisted');
  }
  if (BigInt(state.beneficiaryBalanceWei) >= BigInt(ctx.goal.targetBalanceWei)) {
    return stand('target balance already met');
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
