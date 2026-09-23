// File: web/lib/types.ts
// Core types mirroring the Phase-1 backend API contract (spec §4). TS strict.

export type Hex = `0x${string}`;
export type Address = `0x${string}`;
export type Json = unknown;

export type PolicyInput = {
  perTransferCapWei: string;
  windowCapWei: string;
  windowSeconds: number;
  expiresAt: number; // unix seconds
};

/** The agent's plain-language objective (backend createAgentSchema.goal): keep `beneficiary`
 *  topped up to `targetBalanceWei`, sending at most `topUpWei` per top-up.
 *  Phase-1 treasury bodies carry NO `type` field (byte-compatibility). */
export type GoalInput = {
  type?: 'treasury';
  beneficiary: Address;
  targetBalanceWei: string; // wei
  topUpWei: string; // wei
  model?: string;
};

/** Sentinel (spec §3b): watches and DELEGATES top-up requests; its account is
 *  deployed spend-incapable (zero caps, empty allowlist) — it can never move money. */
export type SentinelGoal = {
  type: 'sentinel';
  beneficiary: Address;
  targetBalanceWei: string; // wei
  topUpWei: string; // wei
  model?: string;
};

/** Executor (spec §3b): acts on inbound delegations within ITS OWN caps. */
export type ExecutorGoal = { type: 'executor'; model?: string };

/** Phase-4 ACP roles (spec §3b). Only the requester spends (governed ERC-20). */
export type RequesterGoal = {
  type: 'requester';
  jobSpecSource: string;
  providerAgentId: string;
  evaluatorAgentId: string;
  feeToken: Address;
  feeRecipient: Address;
  feeCapPerJobWei: string; // token base units
  model?: string;
};
export type ProviderGoal = { type: 'provider'; serviceSpec: string; model?: string };
export type EvaluatorGoal = { type: 'evaluator'; rubricRef: string; model?: string };

export type AgentGoal = GoalInput | SentinelGoal | ExecutorGoal | RequesterGoal | ProviderGoal | EvaluatorGoal;

/** Phase-4 settlement-token config (requester only, F1): immutable token + per-token caps. */
export type TokenConfigInput = {
  settlementToken: Address;
  perTransferCapTokenWei: string;
  windowCapTokenWei: string;
};

export type CreateAgentRequest = {
  name: string;
  policy: PolicyInput;
  allowlist: Address[];
  goal: AgentGoal;
  auditPubKey: string; // hex, no 0x prefix per contract
  /** Opaque AES-GCM blob of the audit privkey; server stores it blind. */
  encryptedAuditKey: string;
  /** Phase-4: required for a requester goal, forbidden otherwise (backend enforces). */
  tokenConfig?: TokenConfigInput;
};

export type CreateAgentResponse = {
  agentId: string;
  accountAddr: Address;
  sessionKeyAddr: Address;
  gatewayToken: string; // shown once
  txHashes: Hex[];
};

export type AgentStatus = 'running' | 'paused' | 'revoked';

/** Gateway interception rule (backend GatewayRule): first match wins. */
export type GatewayRule = {
  action: 'block' | 'modify' | 'require_approval';
  /** case-insensitive substring matched against every message content */
  match: string;
  /** for modify: replacement text substituted for the matched substring */
  replacement?: string;
};

/** Fleet row from GET /api/agents (spec §4 AgentSummary). */
export type AgentRole = 'treasury' | 'sentinel' | 'executor' | 'requester' | 'provider' | 'evaluator';

export type AgentSummary = {
  agentId: string;
  name: string;
  status: 'active' | 'revoked';
  /** Phase-4: runtime role (derived server-side) — lets the create flow pick job agents. */
  role?: AgentRole;
  accountAddr: Address;
  sessionKeyAddr: Address;
  accountBalanceWei: string;
  createdAt: string;
};

export type LinkMode = 'auto' | 'supervised';

/** Owner-authorized directed channel (spec §4). GET /api/links adds delegationCount. */
export type Link = {
  id: string;
  ownerAddr: Address;
  fromAgentId: string;
  toAgentId: string;
  mode: LinkMode;
  status: 'active' | 'paused' | 'removed';
  createdAt: string;
  delegationCount?: number;
};

export type DelegationStatus =
  | 'pending_approval'
  | 'pending'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'declined'
  | 'cancelled'
  | 'expired';

/** Opaque work envelope over a link (spec §4) — kind/payload are platform-opaque. */
export type Delegation = {
  id: string;
  linkId: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  payload: Json;
  status: DelegationStatus;
  result?: Json; // e.g. { txHash } — set by the receiver
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
};

export type AgentDetail = {
  status: AgentStatus;
  policy: PolicyInput & { allowlist: Address[] };
  accountBalance: string; // wei
  sessionExpiry: number; // unix seconds
  addresses: { account: Address; sessionKey: Address; owner: Address };
  /** The guardian LEASH revokes with (M-03): when the live on-chain guardian differs,
   *  one-click revoke is unavailable and the FE warns. Null = legacy pre-backfill. */
  leashGuardianAddr?: Address | null;
  /** Opaque KEK-wrapped audit privkey blob stored blind at create (serialized EncryptedBlob).
   *  Not in the §4 table; the FE also accepts the downloaded backup file as the unlock source. */
  encryptedAuditKey?: string;
  /** Extra context the backend attaches beyond the Phase-1 shape (publicAgent). */
  agent?: {
    id: string;
    name: string;
    goal?: AgentGoal;
    gatewayRules?: GatewayRule[];
    createdAt?: string;
  };
};

export type StreamEvent =
  | { type: 'reasoning'; text: string; seq?: number; ts?: string }
  | {
      type: 'trace';
      kind: string;
      seq: number;
      summary?: string;
      to?: Address;
      valueWei?: string;
      txHash?: Hex;
      ts?: string;
      /** P3C-6(ii): decoded LeashAccount error, when the trace carries one. */
      decoded?: DecodedLeashError;
    }
  | {
      type: 'approval';
      approvalId: string;
      summary: string;
      to?: Address;
      valueWei?: string;
      ts?: string;
    }
  | { type: 'status'; status: AgentStatus; ts?: string }
  | {
      type: 'delegation';
      delegationId: string;
      linkId: string;
      status: DelegationStatus;
      kind: string;
      counterpartyAgentId: string;
      direction: 'outbound' | 'inbound';
      ts: string;
    };

export type DelegationEvent = Extract<StreamEvent, { type: 'delegation' }>;

/** C-2 steer payload attached to a failed guardian revoke (single 502 or batch row). */
export type OwnerRevokeFallback = { accountAddr: Address; method: string; hint: string };

export type RevokeBatchResult = {
  agentId: string;
  ok: boolean;
  txHash?: Hex;
  alreadyRevoked?: boolean;
  error?: string;
  ownerRevokeFallback?: OwnerRevokeFallback;
};

export type TraceRecord = {
  agentId: string;
  seq: number;
  prevHash: Hex;
  ts: string;
  kind: 'inference' | 'action' | 'decision' | 'consent' | 'modify' | 'block' | 'revoke' | 'error';
  originalRequest?: Json;
  effectiveRequest?: Json;
  response?: Json;
  x0gTrace?: { provider: Hex; request_id: string; billing: Json };
  hash: Hex;
};

export type AuditBatch = {
  batchId: string;
  seqFrom: number;
  seqTo: number;
  merkleRoot: Hex;
  storageTx: Hex;
  ciphertextUrl: string;
};

export type ApprovalDecision = { decision: 'approve' | 'deny'; reason?: string };

// ————— Phase 3 (spec §4): alerts, owner stream, digest, settings —————

export type AlertClass = 'decision' | 'info';
export type AlertKind =
  | 'approval_required' // decision — inline approve/deny
  | 'limit_hit' // decision — NOT approvable; adjust/dismiss
  | 'revoked' // info
  | 'revoke_failed' // info — steer to owner-wallet fallback
  | 'delegation_terminal' // info
  | 'runtime_error' // info, coalesced
  | 'throttle' // info, coalesced
  | 'alert_storm'; // info — rate guard tripped
export type AlertStatus = 'unread' | 'read' | 'resolved' | 'dismissed';
export type AlertResolution = 'approve' | 'deny' | 'expired' | 'dismissed';
export type AlertChannel = 'app' | 'telegram' | 'system';

export type Alert = {
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
    /** Approval decision deadline (deny-by-default) — countdown on the card. */
    autoDeniesAtUnix?: number;
    amountWei?: string;
    to?: string;
    /** Agent's own stated purpose — UNTRUSTED (server-sanitized); render labeled + quoted. */
    agentIntent?: string;
  };
  /** Coalesced kinds increment this. */
  count: number;
  dedupKey?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: AlertResolution;
  resolvedVia?: AlertChannel;
};

/** Owner aggregate SSE (spec §4): agent events re-emitted owner-level, tagged. */
export type OwnerStreamEvent =
  | { type: 'agent_event'; agentId: string; event: StreamEvent }
  | { type: 'alert'; alert: Alert }
  | { type: 'digest_ready'; digestId: string };

/** Decoded LeashAccount custom error (P3C-6 ii). */
export type DecodedLeashError = { errorName: string; args: Json; plain: string };

export type AgentDigest = {
  agentId: string;
  name: string;
  status: string;
  spendWei: string;
  balanceWei: string;
  /** null until a snapshot exists (first digest has no baseline — honest). */
  balanceChangeWei: string | null;
  actions: number;
  blocks: number;
  modifies: number;
  approvals: { approved: number; denied: number; expired: number };
  delegationsTerminal: Record<string, number>;
};

export type LinkDigest = {
  linkId: string;
  fromAgentId: string;
  toAgentId: string;
  byStatus: Record<string, number>;
};

export type Digest = {
  generatedAt: string;
  since: string | null;
  agents: AgentDigest[];
  links: LinkDigest[];
  totals: { spendWei: string; actions: number; decisions: number };
  empty: boolean;
};

/** Per-kind channel toggles — in-app is always on; only Telegram is optional. */
export type AlertPrefs = Record<string, { telegram?: boolean }>;

export type OwnerSettingsView = {
  alertPrefs: AlertPrefs;
  digestHourUtc: number | null;
  digestOptout: boolean;
  telegramLinked: boolean;
  telegramLinkedAt: string | null;
  streamPubkeySet: boolean;
};

export type OwnerSettingsPatch = {
  alertPrefs?: AlertPrefs;
  digestHourUtc?: number;
  digestOptout?: boolean;
  /** Set-once — the backend answers 409 on overwrite. */
  streamPubkey?: string;
};

/** Owner-stream hash-chained record (spec §3d) — mirrors TraceRecord discipline. */
export type OwnerRecord = {
  ownerAddr: string;
  seq: number;
  prevHash: Hex;
  ts: string;
  kind: 'alert' | 'alert_resolved' | 'digest';
  record: Json;
  hash: Hex;
};

export type OwnerAuditBatch = AuditBatch & { ownerAddr: string; createdAt: string };

// ── Phase 4 (spec §7): ACP jobs — request → deliver → verify → settle ──

/** The owner-seeded job definition (F5) — the authority the requester executes. */
export type JobSpecFields = {
  question: string;
  context?: string;
  deliverableSchemaRef: string;
  acceptanceRef: string;
};

/** A single generic acceptance rule (F2 — the floor is structural, not semantic). */
export type AcceptanceRule =
  | { kind: 'required'; path: string }
  | { kind: 'type'; path: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array' }
  | { kind: 'numberRange'; path: string; min?: number; max?: number }
  | { kind: 'stringLength'; path: string; min?: number; max?: number }
  | { kind: 'enum'; path: string; values: (string | number | boolean)[] }
  | { kind: 'arrayMinLength'; path: string; min: number };

export type AcceptanceRuleSet = { label?: string; rules: AcceptanceRule[] };

export type OwnerJobSpec = {
  spec: JobSpecFields;
  acceptance: AcceptanceRuleSet;
  feeAmountWei: string;
};

export type AcceptanceResult = { passed: boolean; failures: string[]; checked: number };

export type JobStatus =
  | 'originated'
  | 'delivered'
  | 'evaluating'
  | 'verdict'
  | 'awaiting_approval'
  | 'settled'
  | 'rejected'
  | 'denied'
  | 'failed';

/** The multi-party signed Proof-of-Agreement (F7) — hashes/roots/sigs only. */
export type PoaRecord = {
  jobId: string;
  jobSpecHash: Hex;
  requesterSig: string;
  deliverableRoot: string;
  providerSig: string;
  verdict: 'accept' | 'reject';
  evaluatorSig: string;
  acceptance: { passed: boolean; checked: number; failureCount: number };
  settlementTx?: string;
};

/**
 * A job's full lifecycle view. `deliverable` + `deliverableSummary` (and the
 * resolved rationale) are UNTRUSTED agent text (F-quar) — render QUARANTINED,
 * never mixed into the verified PoA fields.
 */
export type JobView = {
  jobId: string;
  status: JobStatus;
  spec: JobSpecFields;
  jobSpecHash: Hex;
  requesterAgentId: string;
  providerAgentId: string;
  evaluatorAgentId: string;
  feeToken: Hex;
  feeAmountWei: string;
  feeRecipient: Hex;
  deliverable: Json | null; // UNTRUSTED
  deliverableRoot: string | null;
  deliverableSummary: string | null; // UNTRUSTED
  acceptance: AcceptanceResult | null;
  verdict: 'accept' | 'reject' | null;
  rationaleRef: string | null;
  approvalId: string | null;
  settlementTx: string | null;
  poa: PoaRecord | null;
  blockedBy: string | null;
  createdAt: string;
  updatedAt: string;
};
