import type { Json } from './crypto/canonical.js';

export type Hex = `0x${string}`;

/** Core trace types — spec §4, verbatim shape ('error' added: failed upstream forwards are chain-visible). */
// RECORDED SPEC-DRIFT (C-6): 'error' was added during the Phase-1 gate fixes
// (failed forwards / failed revokes are chain-visible) — it is not in the
// Phase-1 spec's TraceKind list. Phase 2 adds the coordination kinds
// 'delegate' | 'delegation_update' | 'config' per spec §4.
export type TraceKind =
  | 'inference'
  | 'action'
  | 'decision'
  | 'consent'
  | 'modify'
  | 'block'
  | 'revoke'
  | 'error'
  | 'delegate' // issuer side: envelope issued (payload rides in the encrypted trace record)
  | 'delegation_update' // either side: accepted/completed/failed/declined/cancelled/expired
  | 'config' // owner config change (gatewayRules, link changes) — original+effective
  | 'direction'; // Phase-5.5: owner conversational directive — confirmed (issuance) or applied (runtime)

export interface TraceRecord {
  agentId: string;
  seq: number;
  prevHash: string;
  ts: string;
  kind: TraceKind;
  originalRequest?: Json;
  effectiveRequest?: Json; // BOTH present on modify
  response?: Json;
  x0gTrace?: X0gTrace;
  hash: string; // hash(prev, canonical(this-without-hash))
  approvalId?: string;
  decision?: 'approve' | 'deny' | 'expired';
  decidedBy?: 'owner' | 'system';
  detail?: Json;
}

export interface X0gTrace {
  provider: string;
  request_id: string;
  billing: Json;
}

export type ConsentRecord = TraceRecord & {
  kind: 'consent';
  approvalId: string;
  decision: 'approve' | 'deny' | 'expired';
  decidedBy: 'owner' | 'system';
};

export interface PolicyView {
  perTransferCap: bigint;
  windowCap: bigint;
  windowSeconds: number;
  expiresAt: number;
  allowlist: string[];
  revoked: boolean;
  /** P3C-6(i): raw window state from the contract's public getters. */
  spentInWindow: bigint;
  windowStart: number;
  /**
   * Phase-4 token settlement observability (F9): present ONLY for v3
   * token-capable accounts (settlementToken != 0). Absent on v2/native-only
   * accounts — the runtime + FE branch on `settlementToken` before reading.
   */
  settlementToken?: string;
  tokenPerTransferCap?: bigint;
  tokenWindowCap?: bigint;
  spentInWindowToken?: bigint;
  windowStartToken?: number;
}

export interface AuditBatch {
  batchId: string;
  agentId: string;
  seqFrom: number;
  seqTo: number;
  merkleRoot: string;
  storageTx: string;
  createdAt: string;
}

export type AgentStatus = 'active' | 'revoked';

/** Gateway interception rules stored per agent (first match wins; default observe). */
export type GatewayRuleAction = 'block' | 'modify' | 'require_approval';

export interface GatewayRule {
  action: GatewayRuleAction;
  /** case-insensitive substring matched against every message content in the request */
  match: string;
  /** for modify: replacement text substituted for the matched substring */
  replacement?: string | undefined;
}

export interface AgentRow {
  id: string;
  chainAgentId: string | null;
  /** SE-5: the chain this agent's account lives on — the (chainId, account) anchor. */
  chainId: number;
  ownerAddr: string;
  accountAddr: string;
  sessionKeyAddr: string;
  sessionKeyEnc: string;
  auditPubkey: string;
  tokenId: string;
  tokenHash: string;
  name: string;
  status: AgentStatus;
  gatewayRules: GatewayRule[];
  goal: AgentGoal;
  /** Opaque client-side-encrypted audit privkey blob; server stores it blind. */
  encryptedAuditKey: string | null;
  /** Runtime copy of the gateway token, AES-256-GCM under KEY_ENCRYPTION_SECRET. */
  gatewayTokenEnc: string | null;
  /** Guardian address this account was created with (C-1/S7); null = legacy ops-key guardian pre-backfill. */
  guardianAddr: string | null;
  /** Phase-5 (D-B9): freeform "what it's for" label (elevation-suggested, owner-edited). Inert — no taxonomy/discovery. */
  capabilityLabel: string | null;
  /**
   * SE-1 (Stage E): on-chain account bytecode version — 4 = governed-calldata V4
   * (the create default), 2 = legacy v2/v3. The runtime/read-model branch on this
   * to know which ABI surface the account exposes (F9 mixed-support).
   */
  accountVersion: number;
  /**
   * SE-6: per-agent CREATE2 salt (0x-prefixed bytes32) for deterministic v4
   * accounts — reused on every chain the agent onboards so the account address
   * is the same everywhere. Null for legacy / non-deterministic mints.
   */
  accountSalt: string | null;
  /**
   * SE-6: the exact canonical v4 construction tuple (serializable) the mint
   * used — replayed verbatim to onboard the agent onto another chain at the
   * SAME CREATE2 address. Null for legacy / pre-SE-6 mints.
   */
  accountCreateTuple: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Role/goal config (spec §3b): a runtime-discriminated union interpreted ONLY
 * by the runtime layer — contracts, APIs, and coordination tables never see
 * the discriminator semantics (generality guard). It lives in agents.goal
 * JSONB. Phase-1 rows carry NO `type` field: missing type ⇒ treasury, so the
 * Phase-1 autonomous mode stays fully supported for solo agents.
 */
export interface TreasuryGoal {
  type?: 'treasury' | undefined;
  beneficiary: string;
  targetBalanceWei: string;
  topUpWei: string;
  model?: string | undefined;
}

/**
 * Sentinel (specimen A): watches the beneficiary balance and DELEGATES
 * `transfer.request` envelopes instead of acting — its account is deployed
 * spend-incapable, and the runtime never routes it to `act`.
 */
export interface SentinelGoal {
  type: 'sentinel';
  beneficiary: string;
  targetBalanceWei: string;
  topUpWei: string;
  model?: string | undefined;
}

/**
 * Executor (specimen B): INBOUND-DRIVEN ONLY — the autonomous top-up decide
 * is disabled (closes the double-actor duplicate-spend hazard, spec §1a); it
 * only processes inbound delegations against its OWN policy.
 */
export interface ExecutorGoal {
  type: 'executor';
  model?: string | undefined;
}

/**
 * Phase-4 Olas-Mech/ACP roles (spec §3b) — the FIRST real instantiation of the
 * goal-union beyond the treasury specimen. All three are runtime-only: the
 * contracts/APIs/coordination tables never see these discriminators (generality
 * guard). Only the REQUESTER spends (governed ERC-20 settlement); provider and
 * evaluator are spend-incapable.
 */

/**
 * Requester (ACP hub): posts an OWNER-SEEDED job (`job.request`) to its provider
 * and, on a verified delivery, settles the governed ERC-20 fee. The fee amount
 * comes from the owner-defined `jobSpec` in server state — NEVER from model or
 * envelope text (F4). `feeCapPerJob` bounds it again, defence-in-depth with the
 * on-chain per-token caps.
 */
export interface RequesterGoal {
  type: 'requester';
  /** Opaque handle to the owner-seeded job spec in server state (F5). */
  jobSpecSource: string;
  /** The provider agent this requester delegates to (server link state, F6). */
  providerAgentId: string;
  /** The evaluator agent that judges deliveries (server link state, F6). */
  evaluatorAgentId: string;
  /** Immutable settlement token this requester's account is configured for. */
  feeToken: string;
  /** Recipient of the fee (must be on the account allowlist). */
  feeRecipient: string;
  /** Owner-defined per-job fee ceiling (token base units), ≤ on-chain per-transfer cap. */
  feeCapPerJobWei: string;
  model?: string | undefined;
}

/**
 * Provider (ACP worker): INBOUND-DRIVEN only (like executor) — receives
 * `job.request`, reasons on 0G Compute, writes a signed deliverable to 0G
 * Storage, returns `job.deliver`. Spend-incapable (never moves funds).
 */
export interface ProviderGoal {
  type: 'provider';
  /** Describes the service the provider offers (owner-defined). */
  serviceSpec: string;
  model?: string | undefined;
}

/**
 * Evaluator (ACP arbiter, ②-B): INBOUND-DRIVEN, spend-incapable (zero caps,
 * empty allowlist, deployed like the sentinel). Receives `job.evaluate`, reads
 * the deliverable + job spec, emits a SKEPTIC verdict (anti-sycophancy, 02 §3).
 * Its model MUST differ from the provider's (F8) so verification does not
 * inherit the provider's blind spots.
 */
export interface EvaluatorGoal {
  type: 'evaluator';
  /** Opaque handle to the owner-defined rubric in server state. */
  rubricRef: string;
  model?: string | undefined;
}

export type AgentGoal =
  | TreasuryGoal
  | SentinelGoal
  | ExecutorGoal
  | RequesterGoal
  | ProviderGoal
  | EvaluatorGoal;

export type AgentRole = 'treasury' | 'sentinel' | 'executor' | 'requester' | 'provider' | 'evaluator';

/** Missing discriminator ⇒ treasury (Phase-1 rows predate the union). */
export function goalRole(goal: AgentGoal): AgentRole {
  return goal.type ?? 'treasury';
}

/**
 * Roles whose accounts are spend-incapable — never routed to act/settle. NOTE
 * executor is NOT here: it spends on inbound delegations against its own policy.
 * Sentinel delegates instead of spending; provider/evaluator never move funds.
 */
export function isSpendIncapableRole(role: AgentRole): boolean {
  return role === 'sentinel' || role === 'provider' || role === 'evaluator';
}

/**
 * The allowlist address(es) a goal cares about, for the cockpit policy view.
 * Treasury/sentinel = beneficiary; requester = fee recipient; executor/
 * provider/evaluator carry none. Returns [] when there is no candidate.
 */
export function goalAllowlistCandidates(goal: AgentGoal): string[] {
  switch (goal.type) {
    case 'requester':
      return [goal.feeRecipient];
    case 'executor':
    case 'provider':
    case 'evaluator':
      return [];
    default:
      return [goal.beneficiary]; // treasury (undefined type) + sentinel
  }
}

/**
 * Coordination layer (spec §4). Links are the ONLY authorization for
 * delegation; delegations carry ZERO authority (00 §6c — the leash is on the
 * hands): kind/payload stay opaque to the platform (generality guard).
 */
export type LinkMode = 'auto' | 'supervised';

export interface Link {
  id: string;
  /** Lowercased owner address — codebase convention (AgentRow.ownerAddr). */
  ownerAddr: string;
  fromAgentId: string;
  toAgentId: string;
  mode: LinkMode;
  status: 'active' | 'paused' | 'removed';
  createdAt: string;
}

export type DelegationStatus =
  | 'pending_approval'
  | 'pending'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'declined'
  | 'cancelled'
  | 'expired';

export interface Delegation {
  id: string;
  linkId: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  /** Opaque to the platform (generality guard). */
  payload: Json;
  status: DelegationStatus;
  /** e.g. {txHash} on completed, {error} on failed — set by the receiver. */
  result?: Json;
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

/**
 * Phase 5.6 agent chaining (spec §4). A chain is the OWNER directing a SEQUENCE
 * of their OWN capabilities where each downstream hop's input carries the prior
 * hop's output. Everything here is a runtime read model / opaque envelope — it
 * confers ZERO authority (the downstream's own on-chain leash binds every act).
 */

/**
 * An owner-authored chain step (QUARANTINED until each hop is owner-approved).
 * `eligibleTargetIds` is the owner-authored SHORTLIST of OWNED, linked
 * capabilities (Option-C, S24) resolved against EXISTING owner-scoped active
 * links (server-state, NEVER model text, NEVER an address). At runtime the
 * upstream selects ONE from the shortlist; the selection is re-validated
 * server-side ∈ this set (BC-2). A one-member set = a fixed hop (no choice);
 * >1 = caged runtime selection.
 */
export interface ChainStep {
  eligibleTargetIds: string[];
  /** Owner-authored, descriptive, quarantined task text for the downstream. */
  directedIntent: string;
}

/** The chain read-model projection (runtime read model, NOT authority; §5). */
export interface Chain {
  id: string;
  ownerAddr: string;
  originAgentId: string;
  directionId: string;
  plan: ChainStep[];
  status: 'planned' | 'running' | 'completed' | 'terminated';
  /** 0-based index of the next hop the runtime will propose. */
  nextHop: number;
  /** Realised path: origin + each selected target, in order (cycle re-check). */
  path: string[];
  currentDelegationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The opaque hop envelope (interpreted ONLY in the runtime graph; opaque to
 * coordination). Rides the EXISTING delegations table (kind/payload already
 * opaque) — no schema change. `upstreamOutput` is LABELED-UNTRUSTED input,
 * NEVER authority; `ownerDirectedIntent` is owner-authored descriptive intent.
 */
export interface ChainHandoffPayload {
  chainId: string;
  hopIndex: number;
  ownerDirectedIntent: string;
  upstreamOutput: Json;
}

/** SSE event emitted on BOTH agents' streams at every lifecycle transition (spec §4). */
export interface DelegationEvent {
  type: 'delegation';
  delegationId: string;
  linkId: string;
  status: DelegationStatus;
  kind: string;
  counterpartyAgentId: string;
  direction: 'outbound' | 'inbound';
  ts: string;
}

/**
 * Phase-3 alert engine (spec §4 types). Shapes are AGENT-GENERIC (generality
 * guard): kinds reference machinery — approvals, boundaries, delegations,
 * revokes, throttles — never goal schemas; role-specific text appears only in
 * the edge-composed `summary` string.
 */
export type AlertClass = 'decision' | 'info';
export type AlertKind =
  | 'approval_required' // decision — actionable approve/deny on both channels
  | 'capability_request' // decision (Stage D L2 JIT) — a novel governed call needs an owner grant; deep-links into the app to sign on-chain
  | 'limit_hit' // decision — NOT approvable (the contract reverts regardless); adjust/dismiss
  | 'revoked' // info
  | 'revoke_failed' // info — actionable steer to owner-wallet fallback
  | 'delegation_terminal' // info — failed | expired | declined | cancelled
  | 'runtime_error' // info, coalesced per (agent, hour)
  | 'throttle' // info, coalesced
  | 'alert_storm' // info — the rate guard tripped; counts suppressed emissions
  | 'wind_down_proposed' // info (Phase-5.5) — agent-PROPOSED completion, quarantined; owner confirms
  | 'completed'; // info (Phase-5.5) — owner wound the agent down (lifespan dial)
export type AlertStatus = 'unread' | 'read' | 'resolved' | 'dismissed';
export type AlertResolution = 'approve' | 'deny' | 'expired' | 'dismissed';
export type AlertChannel = 'app' | 'telegram' | 'system';

export interface Alert {
  id: string;
  ownerAddr: string;
  agentId?: string;
  linkId?: string;
  class: AlertClass;
  kind: AlertKind;
  status: AlertStatus;
  /** Plain-language, composed at the edge (00 §2c). */
  summary: string;
  refs: {
    approvalId?: string;
    delegationId?: string;
    traceSeq?: number;
    errorName?: string;
    boundaryClearsAtUnix?: number;
    [key: string]: Json | undefined;
  };
  /** Coalesced kinds increment this. */
  count: number;
  dedupKey?: string;
  telegramMessageId?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: AlertResolution;
  resolvedVia?: AlertChannel;
}

/** Owner aggregate SSE payloads (spec §4): agent events re-emitted owner-level, tagged. */
export type OwnerStreamEvent =
  | { type: 'agent_event'; agentId: string; event: Json }
  | { type: 'alert'; alert: Alert }
  | { type: 'digest_ready'; digestId: string };

/** Owner-stream hash-chained record kinds (spec §3d). 'poa' = the Phase-4
 * multi-party signed Proof-of-Agreement (F7 — hashes/roots/sigs only). */
export type OwnerRecordKind = 'alert' | 'alert_resolved' | 'digest' | 'poa';

export interface OwnerRecord {
  ownerAddr: string;
  seq: number;
  prevHash: string;
  ts: string;
  kind: OwnerRecordKind;
  record: Json;
  hash: string;
}

/** Decoded LeashAccount custom error (P3C-6 ii). */
export interface DecodedLeashError {
  errorName: string;
  args: Json;
  plain: string;
}

export interface ApprovalRow {
  id: string;
  agentId: string;
  requestRef: Json;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}
