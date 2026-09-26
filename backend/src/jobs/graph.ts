import { randomUUID } from 'node:crypto';
import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { ApprovalDecision } from '../approvals/broker.js';
import { createApproval } from '../store/approvals.js';
import { appendTrace } from '../trace/trace-store.js';
import { appendOwnerRecord } from '../store/owner-records.js';
import { approvalEvent, reasoningEvent, traceEvent } from '../sse/events.js';
import type { Json } from '../crypto/canonical.js';
import { canonicalJson } from '../crypto/canonical.js';
import { eciesEncrypt } from '../crypto/ecies.js';
import type { AgentGoal, AgentRow, RequesterGoal, ProviderGoal, EvaluatorGoal } from '../types.js';
import { CoordinationError, type DelegationCoordinator } from '../coordination/coordinator.js';
import type { AlertService } from '../alerts/service.js';
import { decodeLeashError } from '../chain/errors.js';
import { makeSenseDirection } from '../runtime/sense-direction.js';
import { appendMemory } from '../store/agent-memory.js';
import { formatAsset, shortAddr, inMinutes, sanitizeAgentIntent } from '../util/format.js';
import type { StorageUploader } from '../audit/batcher.js';
import type { RuntimeChain } from '../runtime/session-chain.js';
import type { InboundDelegationInput } from '../runtime/prompt.js';
import {
  parseJobPayload,
  type JobRequestPayload,
  type JobDeliverPayload,
  type JobEvaluatePayload,
  type JobVerdictPayload,
} from './envelopes.js';
import { evaluateAcceptance, renderAcceptanceContract, type AcceptanceResult } from './acceptance.js';
import { evaluateGate } from './gate.js';
import { buildProviderRequest, parseDeliverable, buildEvaluatorRequest, parseVerdict } from './prompt.js';
import { hashJobSpec, verdictMessage, signWithSessionKey, buildPoaRecord } from './poa.js';
import { getJobSpec } from '../store/job-specs.js';
import {
  createJob,
  getJob,
  hasActiveJob,
  recordProviderDeliverable,
  recordDelivery,
  markEvaluating,
  recordVerdict,
  markAwaitingApproval,
  recordSettlement,
  claimSettlement,
  markJobStatus,
} from '../store/jobs.js';

/**
 * The ACP job runtime graph (spec §3b/§3c/§3d) — the sibling of the treasury
 * graph, for the three job roles. ONE graph, branched per (role, inbound) by a
 * deterministic classifier (generality guard: the coordination layer never
 * sees these roles). It mirrors the treasury graph's manager contract exactly:
 * invoke({inboundDelegation}), a pending interrupt surfaces {approvalId} on
 * getState().tasks[].interrupts, and the settle side-effect lives in a resumed
 * node. All state is JSON-serializable for the Postgres checkpointer.
 *
 * Flow per cycle (exactly one envelope, like the treasury graph):
 *   REQUESTER, idle           → originate an owner-seeded job (job.request)
 *   REQUESTER, job.deliver     → acceptance floor → job.evaluate | reject
 *   REQUESTER, job.verdict     → layered gate → owner approval → governed ERC-20 settle + PoA
 *   PROVIDER,  job.request     → reason(0G) → deliverable → 0G Storage → job.deliver
 *   EVALUATOR, job.evaluate    → skeptic reason(0G) → verdict → 0G Storage → job.verdict
 * Any other (role, kind) is an unsupported-kind reject (verbatim markFailed).
 */

export type JobOutcome =
  | { type: 'originated'; jobId: string }
  | { type: 'delivered'; jobId: string }
  | { type: 'evaluated'; jobId: string; verdict: 'accept' | 'reject' }
  | { type: 'settled'; jobId: string; txHash: string; feeToken: string; feeAmountWei: string; feeTokenSymbol: string | null; feeTokenDecimals: number | null }
  | { type: 'rejected'; jobId: string; reason: string }
  | { type: 'denied'; jobId: string }
  | { type: 'noop'; reason: string }
  | { type: 'failed'; reason: string };

type Route =
  | 'provider'
  | 'originate'
  | 'deliver'
  | 'evaluate'
  | 'verdictGate'
  | 'noop';

const JobState = Annotation.Root({
  inboundDelegation: Annotation<InboundDelegationInput | null>,
  route: Annotation<Route>,
  /** Set by verdictGate when the layered gate reaches the owner (approval interrupt). */
  approvalId: Annotation<string>,
  /** The job this cycle acts on (present after verdictGate creates the approval). */
  pendingJobId: Annotation<string>,
  outcome: Annotation<JobOutcome>,
});

type State = typeof JobState.State;

export interface JobGraphDeps {
  pool: Pool;
  hub: SseHub;
  alerts?: AlertService | undefined;
  approvalTimeoutMs?: number | undefined;
  chain: RuntimeChain;
  uploader: StorageUploader;
  gatewayUrl: string;
  defaultModel: string;
  /** §0.6/F8 strong models for the reasoning roles; evaluator MUST differ from provider. */
  providerModel: string;
  evaluatorModel: string;
  getCoordinator?: () => DelegationCoordinator | null;
  fetchFn?: typeof fetch;
}

export interface JobAgentContext {
  agentId: string;
  accountAddr: string;
  goal: AgentGoal;
  agentRow: AgentRow;
  sessionPrivateKey: string;
  gatewayToken: string;
}

type CycleMode =
  | { mode: 'provider'; payload: JobRequestPayload }
  | { mode: 'originate' }
  | { mode: 'deliver'; payload: JobDeliverPayload }
  | { mode: 'evaluate'; payload: JobEvaluatePayload }
  | { mode: 'verdict'; payload: JobVerdictPayload }
  | { mode: 'idle' } // inbound-driven role, nothing to do this cycle
  | { mode: 'reject'; reason: 'unsupported kind' | 'malformed payload' };

/**
 * Deterministic per-cycle classification. Roles interpret the cycle: only the
 * matching (role, kind) is handled; every other combination is an
 * unsupported-kind reject (verbatim markFailed, spec §3b).
 */
export function classifyJobCycle(goal: AgentGoal, inbound: InboundDelegationInput | null | undefined): CycleMode {
  const role = goal.type;
  if (!inbound) {
    // Only the requester originates autonomously (owner-seeded, F5). Provider
    // and evaluator are inbound-driven only — an idle cycle stands down quietly.
    if (role === 'requester') return { mode: 'originate' };
    return { mode: 'idle' };
  }
  const kind = inbound.kind;
  const parsed = parseJobPayload(kind, inbound.payload);
  if (!parsed) {
    // A recognized job kind with a bad payload is 'malformed'; anything else
    // (non-job kind, or a kind this role does not accept) is 'unsupported'.
    return { mode: 'reject', reason: isJobKindString(kind) ? 'malformed payload' : 'unsupported kind' };
  }
  if (role === 'provider' && parsed.kind === 'job.request') return { mode: 'provider', payload: parsed.payload };
  if (role === 'evaluator' && parsed.kind === 'job.evaluate') return { mode: 'evaluate', payload: parsed.payload };
  if (role === 'requester' && parsed.kind === 'job.deliver') return { mode: 'deliver', payload: parsed.payload };
  if (role === 'requester' && parsed.kind === 'job.verdict') return { mode: 'verdict', payload: parsed.payload };
  return { mode: 'reject', reason: 'unsupported kind' };
}

function isJobKindString(kind: string): boolean {
  return kind === 'job.request' || kind === 'job.deliver' || kind === 'job.evaluate' || kind === 'job.verdict';
}

export function buildJobGraph(deps: JobGraphDeps, ctx: JobAgentContext, checkpointer: BaseCheckpointSaver) {
  const fetchFn = deps.fetchFn ?? fetch;
  const coordinator = (): DelegationCoordinator | null => deps.getCoordinator?.() ?? null;
  // Role-aware model (§0.6/F8): only the provider + evaluator reason, and they
  // must use DISTINCT strong models. goal.model (owner override) wins if set.
  const roleModelDefault =
    ctx.goal.type === 'evaluator'
      ? deps.evaluatorModel
      : ctx.goal.type === 'provider'
        ? deps.providerModel
        : deps.defaultModel;
  const model = ctx.goal.model ?? roleModelDefault;
  // Phase-5.5: apply an owner-confirmed directive at the cycle boundary (head node).
  const senseDirection = makeSenseDirection({ pool: deps.pool, hub: deps.hub }, ctx);

  // ---- inference through OUR OWN gateway (interception + trace + queue) ----
  async function gatewayReason(body: Json): Promise<string> {
    const res = await fetchFn(`${deps.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.gatewayToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const completion: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`gateway refused inference: status ${res.status}`);
    const text = completionContent(completion);
    deps.hub.emit(ctx.agentId, 'reasoning', reasoningEvent(text || '(empty model output)'));
    return text;
  }

  /** ECIES(owner audit pubkey) → 0G Storage Log Layer. Returns the Merkle root. */
  async function uploadForOwner(value: Json): Promise<string> {
    const encrypted = eciesEncrypt(ctx.agentRow.auditPubkey, Buffer.from(canonicalJson(value), 'utf8'));
    const { root } = await deps.uploader.upload(encrypted);
    return root;
  }

  // ---- classify ----
  async function classify(state: State): Promise<Partial<State>> {
    const mode = classifyJobCycle(ctx.goal, state.inboundDelegation);
    switch (mode.mode) {
      case 'provider':
        return { route: 'provider' };
      case 'originate':
        return { route: 'originate' };
      case 'deliver':
        return { route: 'deliver' };
      case 'evaluate':
        return { route: 'evaluate' };
      case 'verdict':
        return { route: 'verdictGate' };
      case 'idle':
      case 'reject':
        return { route: 'noop' }; // noop derives the clean/verbatim outcome
    }
  }

  // ---- REQUESTER: originate an owner-seeded job ----
  async function originate(): Promise<Partial<State>> {
    const goal = ctx.goal as RequesterGoal;
    // Dedupe: one owner-seeded job in flight per requester (it executes the ACP
    // lifecycle, it does not spam requests).
    if (await hasActiveJob(deps.pool, ctx.agentId)) {
      return { outcome: { type: 'noop', reason: 'a job is already in flight' } };
    }
    const seeded = await getJobSpec(deps.pool, ctx.agentRow.ownerAddr, goal.jobSpecSource);
    if (!seeded) {
      return { outcome: { type: 'noop', reason: 'no owner-seeded job spec configured' } };
    }
    // F4: the fee comes from server state, bounded again by feeCapPerJob.
    if (BigInt(seeded.feeAmountWei) > BigInt(goal.feeCapPerJobWei)) {
      return { outcome: { type: 'failed', reason: 'seeded fee exceeds feeCapPerJob (misconfigured)' } };
    }
    const jobId = randomUUID();
    const jobSpecHash = hashJobSpec(seeded.spec);
    const requesterSig = await signWithSessionKey(ctx.sessionPrivateKey, jobSpecHash);
    // Detect the settlement asset once (symbol + decimals), so every downstream
    // surface labels the true token instead of assuming 0G. Non-fatal: a read
    // failure just leaves the meta null (rendered as raw base units).
    let feeTokenSymbol: string | null = null;
    let feeTokenDecimals: number | null = null;
    try {
      const meta = await deps.chain.getErc20Meta(goal.feeToken);
      feeTokenSymbol = meta.symbol;
      feeTokenDecimals = meta.decimals;
    } catch {
      /* unknown token metadata — surfaces fall back to raw base units */
    }
    await createJob(deps.pool, {
      jobId,
      ownerAddr: ctx.agentRow.ownerAddr,
      requesterAgentId: ctx.agentId,
      providerAgentId: goal.providerAgentId,
      evaluatorAgentId: goal.evaluatorAgentId,
      spec: seeded.spec,
      jobSpecHash,
      requesterSig,
      feeToken: goal.feeToken,
      feeAmountWei: seeded.feeAmountWei,
      feeRecipient: goal.feeRecipient,
      feeTokenSymbol,
      feeTokenDecimals,
    });
    const deadlineUnix = Math.floor(Date.now() / 1000) + 3600;
    const issued = await issue(goal.providerAgentId, 'job.request', {
      jobId,
      spec: seeded.spec as unknown as Json,
      feeToken: goal.feeToken,
      feeAmountWei: seeded.feeAmountWei,
      deadlineUnix,
      // D-JOB-10: tell the provider the exact required fields (the acceptance
      // rules are the real schema; deliverableSchemaRef is only a name).
      acceptanceContract: renderAcceptanceContract(seeded.acceptance),
    });
    if (!issued.ok) {
      await markJobStatus(deps.pool, jobId, 'failed', { blockedBy: `dispatch: ${issued.reason}` });
      return { outcome: { type: 'failed', reason: `job.request dispatch failed: ${issued.reason}` } };
    }
    return { outcome: { type: 'originated', jobId } };
  }

  // ---- PROVIDER: do the work on 0G, deliver to 0G Storage ----
  async function providerWork(state: State): Promise<Partial<State>> {
    const mode = classifyJobCycle(ctx.goal, state.inboundDelegation);
    if (mode.mode !== 'provider') return { outcome: { type: 'failed', reason: 'not a provider request' } };
    const goal = ctx.goal as ProviderGoal;
    const { jobId, spec, acceptanceContract } = mode.payload;
    const text = await gatewayReason(buildProviderRequest(model, spec, goal.serviceSpec, acceptanceContract));
    const deliverable = parseDeliverable(text);
    if (deliverable === null) {
      return { outcome: { type: 'failed', reason: 'provider produced no schema-valid deliverable' } };
    }
    const deliverableRoot = await uploadForOwner(deliverable);
    const providerSig = await signWithSessionKey(ctx.sessionPrivateKey, deliverableRoot);
    const summary = sanitizeAgentIntent(JSON.stringify(deliverable), 240) ?? 'deliverable produced';
    // Store the plaintext hot copy so the evaluator (a different agent, same
    // owner/DB) can read it; the 0G Storage copy is the permanent audit artifact.
    await recordProviderDeliverable(deps.pool, jobId, { deliverable, deliverableRoot, deliverableSummary: summary, providerSig });
    // M-01: route to the job row's authoritative requester, not the envelope
    // sender — a same-owner mis-link cannot redirect the deliverable elsewhere.
    const dJob = await getJob(deps.pool, jobId);
    const deliverTo = dJob?.requesterAgentId ?? state.inboundDelegation?.fromAgentId ?? '';
    const issued = await issue(deliverTo, 'job.deliver', {
      jobId,
      deliverableRoot,
      deliverableSummary: summary,
      providerSig,
    });
    if (!issued.ok) return { outcome: { type: 'failed', reason: `job.deliver dispatch failed: ${issued.reason}` } };
    return { outcome: { type: 'delivered', jobId } };
  }

  // ---- REQUESTER: acceptance floor on a delivery → evaluate | reject ----
  async function requesterDeliver(state: State): Promise<Partial<State>> {
    const mode = classifyJobCycle(ctx.goal, state.inboundDelegation);
    if (mode.mode !== 'deliver') return { outcome: { type: 'failed', reason: 'not a delivery' } };
    const goal = ctx.goal as RequesterGoal;
    const p = mode.payload;
    const job = await getJob(deps.pool, p.jobId);
    if (!job || job.requesterAgentId !== ctx.agentId) {
      return { outcome: { type: 'failed', reason: 'delivery for an unknown job' } };
    }
    const seeded = await getJobSpec(deps.pool, ctx.agentRow.ownerAddr, goal.jobSpecSource);
    if (!seeded) return { outcome: { type: 'failed', reason: 'acceptance rule set unresolved' } };
    // The evaluator will read the plaintext the provider stored; the acceptance
    // floor runs against that same hot copy (deterministic, no LLM — F2/§3d.1).
    const deliverable = job.deliverable ?? undefined;
    const acceptance: AcceptanceResult = evaluateAcceptance(deliverable, seeded.acceptance);
    if (!acceptance.passed) {
      // Layer 1 blocks: no verdict solicited, no settlement (spec §3d.1).
      await recordDelivery(deps.pool, p.jobId, {
        deliverable: deliverable ?? null,
        deliverableRoot: p.deliverableRoot,
        deliverableSummary: p.deliverableSummary,
        providerSig: p.providerSig,
        acceptance,
        status: 'rejected',
        blockedBy: 'acceptance',
      });
      return { outcome: { type: 'rejected', jobId: p.jobId, reason: `acceptance floor: ${acceptance.failures.join('; ')}` } };
    }
    await recordDelivery(deps.pool, p.jobId, {
      deliverable: deliverable ?? null,
      deliverableRoot: p.deliverableRoot,
      deliverableSummary: p.deliverableSummary,
      providerSig: p.providerSig,
      acceptance,
      status: 'delivered',
    });
    const issued = await issue(job.evaluatorAgentId, 'job.evaluate', {
      jobId: p.jobId,
      deliverableRoot: p.deliverableRoot,
      jobSpecHash: job.jobSpecHash,
    });
    if (!issued.ok) return { outcome: { type: 'failed', reason: `job.evaluate dispatch failed: ${issued.reason}` } };
    await markEvaluating(deps.pool, p.jobId);
    return { outcome: { type: 'delivered', jobId: p.jobId } };
  }

  // ---- EVALUATOR: skeptic verdict on a delivery ----
  async function evaluatorVerdict(state: State): Promise<Partial<State>> {
    const mode = classifyJobCycle(ctx.goal, state.inboundDelegation);
    if (mode.mode !== 'evaluate') return { outcome: { type: 'failed', reason: 'not an evaluation' } };
    const goal = ctx.goal as EvaluatorGoal;
    const p = mode.payload;
    const job = await getJob(deps.pool, p.jobId);
    if (!job || job.deliverable === null) {
      return { outcome: { type: 'failed', reason: 'evaluation for a job with no deliverable' } };
    }
    // F8: the evaluator's model MUST differ from the provider's — enforced at
    // create; the skeptic prompt (anti-sycophancy) defaults to reject.
    const text = await gatewayReason(buildEvaluatorRequest(model, job.spec, job.deliverable, goal.rubricRef));
    const parsed = parseVerdict(text);
    // A malformed/absent verdict is treated as REJECT (fail-closed on payment).
    const verdict: 'accept' | 'reject' = parsed?.verdict ?? 'reject';
    const rationale = parsed?.rationale ?? 'no parseable rationale — defaulted to reject';
    const rationaleRef = await uploadForOwner({ verdict, rationale });
    const evaluatorSig = await signWithSessionKey(ctx.sessionPrivateKey, verdictMessage(p.jobId, verdict, p.deliverableRoot));
    // M-01: reply to the job's authoritative requester, not the envelope sender.
    const issued = await issue(job.requesterAgentId ?? state.inboundDelegation?.fromAgentId ?? '', 'job.verdict', {
      jobId: p.jobId,
      verdict,
      rationaleRef,
      evaluatorSig,
    });
    if (!issued.ok) return { outcome: { type: 'failed', reason: `job.verdict dispatch failed: ${issued.reason}` } };
    return { outcome: { type: 'evaluated', jobId: p.jobId, verdict } };
  }

  // ---- REQUESTER: the layered gate + owner approval interrupt ----
  async function verdictGate(state: State): Promise<Partial<State>> {
    const mode = classifyJobCycle(ctx.goal, state.inboundDelegation);
    if (mode.mode !== 'verdict') return { outcome: { type: 'failed', reason: 'not a verdict' }, route: 'noop' };
    const p = mode.payload;
    const job = await getJob(deps.pool, p.jobId);
    if (!job || job.requesterAgentId !== ctx.agentId) {
      return { outcome: { type: 'failed', reason: 'verdict for an unknown job' }, route: 'noop' };
    }
    // P5C-2: a re-emitted / duplicate job.verdict must be idempotent. recordVerdict
    // advances ONLY from an evaluatable state (returns false otherwise), and a job
    // that already carries an approval_id must never spawn a second approval card
    // (the settle CAS blocks double-pay, but a stray card confuses a fund action).
    const advanced = await recordVerdict(deps.pool, p.jobId, {
      verdict: p.verdict,
      rationaleRef: p.rationaleRef,
      evaluatorSig: p.evaluatorSig,
    });
    if (!advanced || job.approvalId) {
      return { outcome: { type: 'rejected', jobId: p.jobId, reason: 'duplicate or out-of-state verdict ignored' }, route: 'noop' };
    }
    const acceptance = job.acceptance ?? { passed: false, failures: ['acceptance not run'], checked: 0 };
    // Layered gate (spec §3d): acceptance floor → evaluator verdict → owner.
    const gate = evaluateGate({ acceptance, verdict: p.verdict, owner: 'pending' });
    if (!gate.release && gate.blockedBy !== 'owner') {
      // Blocked at layer 1 or 2 — never reaches the owner (spec §3d).
      await markJobStatus(deps.pool, p.jobId, 'rejected', { blockedBy: gate.blockedBy ?? 'gate' });
      return { outcome: { type: 'rejected', jobId: p.jobId, reason: gate.reason }, route: 'noop' };
    }
    // Layers 1+2 passed → the owner-supervised release (the 00 §1a decision).
    const approval = await createApproval(deps.pool, ctx.agentId, {
      kind: 'settlement',
      jobId: p.jobId,
      to: job.feeRecipient,
      token: job.feeToken,
      amountWei: job.feeAmountWei,
      verdict: p.verdict,
    });
    await markAwaitingApproval(deps.pool, p.jobId, approval.id);
    // Label the true settlement asset (e.g. "2 USDC" / "0.5 0G"), never assume 0G.
    const feeLabel = formatAsset(job.feeAmountWei, job.feeTokenDecimals, job.feeTokenSymbol);
    deps.hub.emit(
      ctx.agentId,
      'approval',
      approvalEvent({
        approvalId: approval.id,
        summary: `Release ${feeLabel} to ${shortAddr(job.feeRecipient)}?`,
        to: job.feeRecipient,
        valueWei: job.feeAmountWei,
        assetLabel: feeLabel,
      }),
    );
    if (deps.alerts) {
      const deadline =
        deps.approvalTimeoutMs !== undefined
          ? ` ⏱ Auto-denies in ${inMinutes(deps.approvalTimeoutMs)} if you don't answer.`
          : ' ⏱ Auto-denies if you don\'t answer in time.';
      // Both the deliverable summary and the evaluator rationale are UNTRUSTED
      // (F-quar): sanitized, carried in refs, never in the verified summary.
      const deliverableIntent = sanitizeAgentIntent(job.deliverableSummary ?? undefined);
      // Card redesign: name the JOB, state WHY approval is being asked (the work
      // cleared both automatic checks), and frame the tap as the final release
      // gate — approve pays the agreed fee now, deny withholds it.
      const question = sanitizeAgentIntent(job.spec.question, 140);
      await deps.alerts.emit(ctx.agentRow.ownerAddr, {
        agentId: ctx.agentId,
        class: 'decision',
        kind: 'approval_required',
        summary:
          `${ctx.agentRow.name} finished a job${question ? ` (“${question}”)` : ''} and it cleared both automatic checks — ` +
          `the deliverable passed the acceptance rules and the skeptic evaluator accepted it. ` +
          `Your approval is the final gate: approve to release the agreed fee of ${feeLabel} to ${shortAddr(job.feeRecipient)}, or deny to withhold it.` +
          deadline,
        refs: {
          approvalId: approval.id,
          jobId: p.jobId,
          amountWei: job.feeAmountWei,
          feeLabel,
          ...(job.feeTokenSymbol ? { feeTokenSymbol: job.feeTokenSymbol } : {}),
          ...(job.feeTokenDecimals !== null ? { feeTokenDecimals: job.feeTokenDecimals } : {}),
          feeToken: job.feeToken,
          to: job.feeRecipient,
          ...(deliverableIntent ? { deliverableSummary: deliverableIntent } : {}),
          ...(deps.approvalTimeoutMs !== undefined
            ? { autoDeniesAtUnix: Math.floor((Date.now() + deps.approvalTimeoutMs) / 1000) }
            : {}),
        },
      });
    }
    return { approvalId: approval.id, pendingJobId: p.jobId, route: 'verdictGate' };
  }

  // ---- REQUESTER: pause for owner approval, then governed ERC-20 settle ----
  async function requestApproval(state: State): Promise<Partial<State>> {
    const resume = interrupt<Json, ApprovalDecision>({ approvalId: state.approvalId, jobId: state.pendingJobId });
    const job = await getJob(deps.pool, state.pendingJobId);
    if (!job) return { outcome: { type: 'failed', reason: 'job vanished before settlement' } };
    if (resume.decision !== 'approve') {
      await markJobStatus(deps.pool, job.jobId, 'denied', { blockedBy: 'owner' });
      return { outcome: { type: 'denied', jobId: job.jobId } };
    }
    // H-01 double-settle guard: atomically claim the job (awaiting_approval →
    // settling) BEFORE the irreversible on-chain transfer. The claim is a
    // compare-and-set on THIS jobId's status, so a checkpoint replay, a stale
    // interrupt, or a double owner-decide notify loses the race and never pays
    // twice. (Cross-job replay is already impossible: the resume is bound to
    // this job's graph thread and this approval's broker.notify.)
    const claimed = await claimSettlement(deps.pool, job.jobId);
    if (!claimed) {
      return { outcome: { type: 'failed', reason: `settlement not claimable (job ${job.status} — double-settle prevented)` } };
    }
    // F4: fee token/recipient/amount ALL from the job row (server state) — the
    // contract's per-token caps enforce again (defence in depth).
    try {
      const { txHash } = await deps.chain.executeTokenTransfer({
        sessionPrivateKey: ctx.sessionPrivateKey,
        accountAddr: ctx.accountAddr,
        token: job.feeToken,
        to: job.feeRecipient,
        amountWei: BigInt(job.feeAmountWei),
      });
      const poa = buildPoaRecord({
        jobId: job.jobId,
        jobSpecHash: job.jobSpecHash,
        requesterSig: job.requesterSig,
        deliverableRoot: job.deliverableRoot ?? '',
        providerSig: job.providerSig ?? '',
        verdict: job.verdict ?? 'accept',
        evaluatorSig: job.evaluatorSig ?? '',
        acceptance: job.acceptance ?? { passed: true, failures: [], checked: 0 },
        settlementTx: txHash,
      });
      await recordSettlement(deps.pool, job.jobId, { settlementTx: txHash, poa });
      // The signed multi-party PoA → the owner-record / audit stream (→ 0G
      // Storage, hash-chained). Only hashes/roots/sigs — never untrusted text.
      await appendOwnerRecord(deps.pool, ctx.agentRow.ownerAddr, 'poa', poa as unknown as Json);
      return {
        outcome: {
          type: 'settled',
          jobId: job.jobId,
          txHash,
          feeToken: job.feeToken,
          feeAmountWei: job.feeAmountWei,
          feeTokenSymbol: job.feeTokenSymbol,
          feeTokenDecimals: job.feeTokenDecimals,
        },
      };
    } catch (err) {
      const decoded = decodeLeashError(err);
      const reason = decoded ? `settle refused: ${decoded.plain}` : `settle failed: ${err instanceof Error ? err.message : String(err)}`;
      await markJobStatus(deps.pool, job.jobId, 'failed', { blockedBy: 'settlement' });
      return { outcome: { type: 'failed', reason } };
    }
  }

  // ---- noop / inbound reject ----
  async function noop(state: State): Promise<Partial<State>> {
    // If an upstream node (verdictGate blocked, originate deduped) already set
    // the outcome, keep it. Otherwise derive it from the cycle classification.
    if (state.outcome) return {};
    const mode = classifyJobCycle(ctx.goal, state.inboundDelegation);
    if (mode.mode === 'reject') return { outcome: { type: 'failed', reason: mode.reason } };
    return { outcome: { type: 'noop', reason: 'nothing to do this cycle' } };
  }

  // ---- record + inbound outcome posting ----
  async function record(state: State): Promise<Partial<State>> {
    const o = state.outcome;
    // An idle/dedupe poll is a non-event: recording it every RUNTIME_INTERVAL_MS
    // would spam the tamper-evident chain (a provider/evaluator idles for long
    // stretches between jobs). Only meaningful outcomes are traced.
    if (o.type !== 'noop') {
      const summary = outcomeSummary(o);
      const kind = o.type === 'settled' ? 'action' : 'decision';
      const detail: Record<string, Json> = { summary };
      if (o.type === 'settled') {
        detail['txHash'] = o.txHash;
        // §8 calibration: a job-fee settlement is a governed ERC-20 transfer, NOT
        // a native treasury spend. Label it distinctly (category + token amount,
        // never native valueWei) so the digest reports it in its own line and
        // doesn't conflate 6dp token fees with 18dp 0G outflows.
        detail['category'] = 'jobFee';
        detail['feeToken'] = o.feeToken;
        detail['feeAmountWei'] = o.feeAmountWei;
        // P5C-4: carry the asset meta so the digest can render the true amount
        // ("2 TestUSD"), not just a count — data already computed at originate.
        if (o.feeTokenSymbol !== null) detail['feeTokenSymbol'] = o.feeTokenSymbol;
        if (o.feeTokenDecimals !== null) detail['feeTokenDecimals'] = o.feeTokenDecimals;
      }
      if ('jobId' in o) detail['jobId'] = o.jobId;
      const rec = await appendTrace(deps.pool, { agentId: ctx.agentId, kind, detail });
      deps.hub.emit(ctx.agentId, 'trace', traceEvent(rec));
      // Phase-5.5 working memory (S23): a salient, QUARANTINED-UNTRUSTED finding
      // for the conversational-status query. Bounded rolling window; read-only.
      await appendMemory(deps.pool, { agentId: ctx.agentId, kind: o.type, content: detail as Json });
    }
    await postInboundOutcome(state);
    return {};
  }

  async function postInboundOutcome(state: State): Promise<void> {
    const inbound = state.inboundDelegation;
    if (!inbound) return;
    const c = coordinator();
    if (!c) return;
    const o = state.outcome;
    // The RECEIVER acted on the envelope: completed = it did its job (even a
    // reject is a completed evaluation); failed = it could not.
    if (o.type === 'settled') {
      await c.markCompleted(inbound.delegationId, { txHash: o.txHash });
    } else if (o.type === 'delivered' || o.type === 'evaluated' || o.type === 'rejected' || o.type === 'denied') {
      await c.markCompleted(inbound.delegationId, { outcome: o.type });
    } else if (o.type === 'failed') {
      await c.markFailed(inbound.delegationId, o.reason);
    } else {
      await c.markFailed(inbound.delegationId, 'unhandled inbound');
    }
  }

  /** Issue an envelope over the issuer's active link; failures are traced, non-crashing. */
  async function issue(
    toAgentId: string,
    kind: string,
    payload: Json,
  ): Promise<{ ok: true; delegationId: string } | { ok: false; reason: string }> {
    const c = coordinator();
    if (!c) return { ok: false, reason: 'coordinator unavailable' };
    if (!toAgentId) return { ok: false, reason: 'no target agent' };
    try {
      const d = await c.issueDelegation({ fromAgent: ctx.agentRow, kind, payload, toAgentId });
      return { ok: true, delegationId: d.id };
    } catch (err) {
      if (err instanceof CoordinationError) return { ok: false, reason: err.reason };
      throw err;
    }
  }

  return new StateGraph(JobState)
    .addNode('sense_direction', senseDirection)
    .addNode('classify', classify)
    .addNode('originate', originate)
    .addNode('providerWork', providerWork)
    .addNode('requesterDeliver', requesterDeliver)
    .addNode('evaluatorVerdict', evaluatorVerdict)
    .addNode('verdictGate', verdictGate)
    .addNode('requestApproval', requestApproval)
    .addNode('noop', noop)
    .addNode('record', record)
    .addEdge(START, 'sense_direction')
    .addEdge('sense_direction', 'classify')
    .addConditionalEdges('classify', (s: State) => s.route, {
      provider: 'providerWork',
      originate: 'originate',
      deliver: 'requesterDeliver',
      evaluate: 'evaluatorVerdict',
      verdictGate: 'verdictGate',
      noop: 'noop',
    })
    .addConditionalEdges('verdictGate', (s: State) => (s.approvalId ? 'approval' : 'record'), {
      approval: 'requestApproval',
      record: 'record',
    })
    .addEdge('originate', 'record')
    .addEdge('providerWork', 'record')
    .addEdge('requesterDeliver', 'record')
    .addEdge('evaluatorVerdict', 'record')
    .addEdge('requestApproval', 'record')
    .addEdge('noop', 'record')
    .addEdge('record', END)
    .compile({ checkpointer });
}

export type JobGraph = ReturnType<typeof buildJobGraph>;

function completionContent(completion: unknown): string {
  const choices = (completion as { choices?: Array<{ message?: { content?: string } }> } | null)?.choices;
  return choices?.[0]?.message?.content ?? '';
}

function outcomeSummary(o: JobOutcome): string {
  switch (o.type) {
    case 'originated':
      return `posted job ${o.jobId}`;
    case 'delivered':
      return `delivery accepted, evaluating job ${o.jobId}`;
    case 'evaluated':
      return `evaluated job ${o.jobId}: ${o.verdict}`;
    case 'settled':
      return `settled job ${o.jobId} (tx ${o.txHash})`;
    case 'rejected':
      return `job ${o.jobId} rejected: ${o.reason}`;
    case 'denied':
      return `owner denied settlement for job ${o.jobId}`;
    case 'noop':
      return `no action: ${o.reason}`;
    case 'failed':
      return o.reason;
  }
}
