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

/** Trader (FR3/F-8): autonomous governed-swap role — accumulates holdToken by
 *  swapping spendToken via owner-granted capabilities, one clip per cycle.
 *  Token addresses are owner-typed at create; it never sends native funds. */
export type TraderGoal = {
  type: 'trader';
  holdToken: Address;
  spendToken: Address;
  targetHoldWei: string; // token base units
  clipWei: string; // token base units
  model?: string;
};

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

export type AgentGoal = GoalInput | SentinelGoal | ExecutorGoal | TraderGoal | RequesterGoal | ProviderGoal | EvaluatorGoal;

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
  /** Phase-5 (D-B9): optional freeform capability label (elevation-suggested, owner-edited). Inert. */
  capabilityLabel?: string;
  /** SE-7: which registered chain to mint on. Default = home 0G chain when omitted. */
  chainId?: number;
  /** RH2 (two-factory): mint through a named wall-capability factory (e.g. `oracleBand`). */
  capability?: string;
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
export type AgentRole = 'treasury' | 'sentinel' | 'executor' | 'trader' | 'requester' | 'provider' | 'evaluator';

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

/**
 * Phase 5.6 agent chaining (spec §4). Owner-authored, quarantined until each hop
 * is approved. eligibleTargetIds are OWNED, linked agents (server-state, never
 * an address). A one-member set = a fixed hop; >1 = caged runtime selection.
 */
export type ChainStep = {
  eligibleTargetIds: string[];
  directedIntent: string;
};

export type Chain = {
  id: string;
  ownerAddr: Address;
  originAgentId: string;
  directionId: string;
  plan: ChainStep[];
  status: 'planned' | 'running' | 'completed' | 'terminated';
  nextHop: number;
  path: string[];
  currentDelegationId: string | null;
  createdAt: string;
  updatedAt: string;
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
    /** Phase-5 (D-B9): freeform "what it's for" label (publicAgent). Inert — display only. */
    capabilityLabel?: string;
    /** RH2 (B1): on-chain account grammar version — the owner-arming panels pick the
     *  encoding ABI from this (5 = V5 superset, 4 = V4, 2 = legacy). Absent on legacy
     *  detail payloads → the owner-write path falls back to V4 (byte-identical for the
     *  shared call-rule/band/spend fragments). */
    accountVersion?: number;
  };
};

// ── RH2 B2 (TA-ABI-5 close): governed-signing grant read-model (V5 accounts) ──
// Mirrors the backend `GET /api/agents/:id/signing` envelope + the on-chain grant
// params the owner signs. The on-chain V5 account stays authoritative; these shapes
// are the read-model view the SigningGrantPanel renders.

/** The on-chain grant params the owner's `proposeSigningGrantNested` tx must store —
 *  byte-exact to the backend `onChainGrantParams(descriptor)`. */
export type OnChainSigningGrantView = {
  descriptorId: number;
  domainSeparator: Address;
  typeHash: Address;
  numFields: number;
  spenderIndex: number;
  amountIndex: number;
  deadlineIndex: number;
  nestedTypeHash: Address;
  nestedLeafStart: number;
  nestedLeafCount: number;
  expiryLeafIndex: number;
  kind: number;
  buyToken: Address;
  tokenCaps: { token: Address; cap: string }[];
  tokenCapsHash: Address;
};

/** One reviewed, grantable signing descriptor (the registry entries the owner can arm). */
export type SigningDescriptorView = {
  descriptorId: number;
  key: string;
  label: string;
  protocol: string;
  sensitive: boolean;
  onChainGrant: OnChainSigningGrantView;
};

/** A standing signing grant the owner already armed (read-model mirror of the wall). */
export type SigningRuleView = {
  descriptorId: number;
  spenderSet: Address[];
  perIntentCap: string;
  maxDeadlineWindow: number;
  token: Address;
  tokenCaps?: { token: Address; cap: string }[];
  active: boolean;
};

/** The read-only signing envelope the cockpit panel loads. */
export type SigningEnvelopeView = {
  rules: SigningRuleView[];
  recentRequests: unknown[];
  arms: unknown[];
  available: SigningDescriptorView[];
};

/** propose = loosen (timelocked) / tighten (instant) / remove (instant). */
export type SigningGrantAction = 'propose' | 'tighten' | 'remove';

export type StreamEvent =
  | {
      type: 'reasoning';
      text: string;
      seq?: number;
      ts?: string;
      /**
       * AQ-A0-Q2VIS D-2: health of the cycle that produced `text`, so the feed can degrade
       * instead of rendering 64 KB of repetition when the model loops.
       */
      meta?: {
        truncated: boolean;
        loopCount: number;
        decisionSource: 'content' | 'scavenge' | 'empty';
        clipped: boolean;
      };
    }
  | {
      type: 'trace';
      kind: string;
      seq: number;
      summary?: string;
      to?: Address;
      valueWei?: string;
      txHash?: Hex;
      ts?: string;
      /** Q5 (presentation): the model's own plain-language WHY for this action/decision. */
      reason?: string;
      /**
       * AQ-A0-Q2VIS D-4 owner layer: the agent's OWN WORDS about this decision. Sanitized
       * server-side, but NEVER verified — render it as attributed, quarantined agent voice beside
       * the authoritative `summary`, never as a fact in its own right. (Three Gate-② rounds proved
       * no lexical check can certify that free prose entails a decision.)
       */
      rationale?: string;
      /** Quality signal only: the backend's lexical agreement check passed. NOT a trust claim. */
      rationaleAgrees?: boolean;
      /** P3C-6(ii): decoded LeashAccount error, when the trace carries one. */
      decoded?: DecodedLeashError;
    }
  | {
      type: 'approval';
      approvalId: string;
      summary: string;
      to?: Address;
      valueWei?: string;
      /** Pre-formatted true settlement asset (e.g. "2 USDC"). Absent ⇒ native 0G. */
      assetLabel?: string;
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
  | 'alert_storm' // info — rate guard tripped
  | 'gas_request'; // decision — the agent found no way to pay its own gas (AQ-FND M-3)
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
  /** P5C-4: pre-formatted human job-fee total ("2 TestUSD") when known. */
  jobFees?: { count: number; byToken: Record<string, string>; feeLabel?: string };
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
  /** B-6: fleet lifecycle since the mark (optional: pre-B-6 records lack it). */
  lifecycle?: {
    created: Array<{ agentId: string; name: string }>;
    onboarded: Array<{ agentId: string; name: string; chainId: number }>;
    linksCreated: Array<{ linkId: string; fromAgentId: string; toAgentId: string }>;
  };
  totals: { spendWei: string; actions: number; decisions: number; jobFees?: { count: number; byToken: Record<string, string>; feeLabel?: string } };
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
  /** Rotatable — requires the NC-2 owner EIP-712 signature + nonce below. */
  streamPubkey?: string;
  /** NC-2: owner SetAuditPubkey signature; required when streamPubkey is set. */
  signature?: string;
  /** NC-2: monotonic replay nonce bound into the signature. */
  nonce?: string;
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

// ── Phase 5 (Stage B): spec-elevation — the QUARANTINED create-funnel draft ──
// Mirrors backend/src/create/elevation.ts (elevationDraftSchema). A SUGGESTION
// only: never authority until the owner confirms on the read-back. NOTE the
// deliberate absence of any recipient/allowlist/settlement-token ADDRESS field
// and of a pre-filled fee — never-guess-money (spec §8). Authored ROLE-NEUTRAL
// so Phase 5.5 reuses the read-back at direction-time (spec §9).

/** Caps elevation may SUGGEST (native). Expiry stays an owner create-time choice. */
export type SuggestedPolicy = { perTransferCapWei: string; windowCapWei: string; windowSeconds: number };

export type ElevationDraft = {
  proposedRole: AgentRole;
  /** Plain-language "here's what I understood" — UNTRUSTED text, render as plain text. */
  rationale: string;
  /** Freeform "what it's for" (no taxonomy). */
  capabilityLabel?: string;
  jobSpec?: { fields: JobSpecFields; acceptance: AcceptanceRule[] };
  serviceSpec?: string;
  rubricRef?: string;
  suggestedPolicy?: SuggestedPolicy;
  suggestedTokenPerTransferWei?: string;
  suggestedTokenWindowWei?: string;
  /** ONLY set when the user's own intent stated an explicit base-units amount; never guessed. */
  suggestedFeeBaseUnits?: string;
  /** Plain-language translation of the role's money-power, so a wrong-role draft is human-catchable. */
  moneyPower: 'can-move-money' | 'cannot-move-money';
  /** Field paths elevation was unsure about → inline guided questions in the read-back. */
  unsureFields: string[];
  confidence: 'high' | 'low';
};

export type ElevateRequest = { intent: string; answers?: string[]; role?: AgentRole };

// ── Phase 5.5 (spec §9): conversational direction — the QUARANTINED redirect draft ──
// A running agent is re-directed at cockpit-time. Like ElevationDraft it is a SUGGESTION
// only, never authority: the owner reads it back and confirms. NOTE the deliberate absence
// of any address/token/fee field on the draft — never-guess-money (spec §8) is structural.

export type DirectionDraft = {
  agentId: string;
  currentRole: AgentRole;
  /** Plain-language "here's the new task I understood" — UNTRUSTED text, render as plain text. */
  understanding: string;
  /** Descriptive-only goal patch (e.g. { targetBalanceWei, topUpWei } | { serviceSpec } | { rubricRef }).
   *  NEVER carries an address/token/fee — those stay owner-typed and out-of-band. */
  goalPatch: Record<string, unknown>;
  acceptancePatch?: unknown[];
  /** SHOWN, never armed here — a loosen rides the on-chain timelocked propose/apply. */
  suggestedPolicy?: SuggestedPolicy;
  /** ONLY set when the owner's own intent stated an explicit base-units amount; never guessed. */
  suggestedFeeBaseUnits?: string;
  /** SERVER-computed money-power of the current role — display only. */
  moneyPower: 'can-move-money' | 'cannot-move-money';
  unsureFields: string[];
  confidence: 'high' | 'low';
};

export type DirectRequest = { intent: string; answers?: string[]; threadId?: string };

/** A curated create template — a static ElevationDraft, no LLM call (D-B5). */
export type CreateTemplate = { id: string; title: string; blurb: string; draft: ElevationDraft };

/** A saved job-spec summary for the requester job-handle picker (D-A2). */
export type JobSpecSummary = { ref: string; label: string; questionPreview: string };

export type OwnerJobSpec = {
  spec: JobSpecFields;
  acceptance: AcceptanceRuleSet;
  feeAmountWei: string;
};

export type AcceptanceResult = { passed: boolean; failures: string[]; checked: number };

// ── Stage D (spec §7): governed-calldata capability grants ──
// The on-chain LeashAccountV4 wall is the sole enforcement guarantee; every type
// here mirrors the backend read-model (capability_grants / capability_requests)
// and the CallRule the account enforces, so the surface can never claim more than
// the wall grants. Decoded agent intent is QUARANTINED (label 'UNVERIFIED') — plain
// text, never markup.

export type PresetKey = 'defi_trader' | 'yield_manager' | 'treasury_topper' | 'dca' | 'rebalancer' | 'leverage_adv';

/** Novelty categories the JIT gate raises (mirrors backend Novelty). */
export type Novelty =
  | 'new_target'
  | 'new_selector'
  | 'over_cap'
  | 'over_budget'
  | 'new_spender'
  | 'new_recipient'
  | 'bridge'
  | 'self_edit';

export type RecipientMode = 'self' | 'allowlist';

/** The call-rule object the backend accepts (custom rule / always-allow). */
export type CallRule = {
  target: Address;
  selector: Hex; // 0x + 8 hex
  recipientMode: RecipientMode;
  spenderSet: Address[];
  perCallCap: string; // base units
  windowCapCall: string; // base units
  codehash?: Hex; // 0x + 64 hex; omit ⇒ no pin (v1)
};

/** Server mirror of the resolved preset (rules + budgets + JIT deny-list). */
export type ResolvedPreset = {
  key: PresetKey;
  label: string;
  description: string;
  rules: CallRule[];
  budgets: { token: Address; windowCap: string }[];
  denyList: Novelty[];
};

export type GrantStatus = 'proposed' | 'active' | 'removed';

/** A capability_grants row (read-model; the account stays authoritative). */
export type CapabilityGrantRow = {
  id: string;
  agentId: string;
  ownerAddr: Address;
  target: Address;
  selector: Hex;
  recipientMode: RecipientMode;
  spenderSet: Address[];
  perCallCap: string;
  windowCapCall: string;
  codehash: string | null;
  source: string; // 'preset' | 'custom'
  status: GrantStatus;
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
};

/** An applied-preset row. */
export type AppliedPresetRow = { presetKey: PresetKey };

export type RequestStatus = 'pending' | 'approved_once' | 'always_allowed' | 'denied' | 'expired';

/** Quarantined decoded intent on a JIT request — 'UNVERIFIED', render as PLAIN TEXT. */
export type DecodedIntent = {
  label: 'UNVERIFIED';
  target: Address;
  selector: Hex;
  signature: string | null;
  value: string;
  humanReadable: string;
  novelty: Novelty[];
};

/** A capability_requests row (recent JIT decisions / pending). */
export type CapabilityRequestRow = {
  id: string;
  decoded: DecodedIntent;
  novelty: Novelty[];
  callHash: Hex;
  status: RequestStatus;
  approvalId: string | null;
  /** SE-2: the exact refused bytes (server-authored, bound by callHash) — the
   *  SERVER-verified decode source for structured selectors (e.g. SE-8 bridges). */
  callValue?: string | null;
  callData?: string | null;
};

/** GET /api/agents/:id/capabilities response. */
export type CapabilityEnvelopeView = {
  grants: CapabilityGrantRow[];
  presets: AppliedPresetRow[];
  recentRequests: CapabilityRequestRow[];
};

export type CapabilityRuleAction = 'propose' | 'tighten' | 'remove' | 'apply';
export type CapabilityDecision = 'approve_once' | 'always_allow' | 'deny';

export type JobStatus =
  | 'originated'
  | 'delivered'
  | 'evaluating'
  | 'verdict'
  | 'awaiting_approval'
  // The backend has had 'settling' since the double-settle claim landed, but
  // this mirror omitted it — so such a job fell out of every
  // Record<JobStatus, …> lookup in the cockpit and crashed the render. It is
  // now the NORMAL state of a broadcast-but-unconfirmed fee transfer rather
  // than a blink between two writes, so the gap stops being latent.
  | 'settling'
  | 'settled'
  | 'rejected'
  | 'denied'
  | 'failed';

// ── Stage E / SE-7 (spec §7.C): multichain networks ──
// NOTE: /api/networks is the BLOCKCHAIN network table. /api/chains (Chain above) is the
// agent-chaining delegation graph — a different concept entirely.

/** A registered blockchain network (GET /api/networks). */
export type NetworkChain = {
  chainId: number;
  name: string;
  /** RH2: named wall-capability keys this chain can mint through (e.g. `oracleBand`). */
  capabilities: string[];
  /** FR4 (F-9): the chain's canonical swap router (band-arm target), when configured. */
  router?: string | null;
};

/** One per-chain presence row for an agent — SAME accountAddr on every chain. */
export type AgentNetworkRow = {
  chainId: number;
  accountAddr: Address;
  role: 'home' | 'onboarded';
  createTx?: string;
  registerTx?: string;
  adopted?: boolean;
  createdAt?: string;
};

/** GET /api/agents/:id/networks response. */
export type AgentNetworksView = {
  accountAddr: Address;
  onboardable: boolean;
  homeChainId: number;
  chains: AgentNetworkRow[];
};

/** GET /api/agents/:id/gas-survey (AQ-FND M-3): holdings per chain + the gas route the agent would take. */
export type GasSurveyChain = {
  chainId: number;
  name: string;
  /** `unknown` = the chain could not be read; it is NOT zero. */
  status: 'ok' | 'unknown';
  /** wei, as a decimal string */
  sessionNativeWei: string;
  accountNativeWei: string;
  spendableTokens: Array<{ token: Address; balance: string }>;
};

export type GasSurveyRoute = {
  mode: 'has-native' | 'account-native' | 'swap-to-gas' | 'bridge-then-swap' | 'ask-owner';
  reason: string;
  legs: Array<{ kind: 'refuel' | 'swap' | 'bridge'; chainId: number; requiresGrants: string[] }>;
  ask?: { surveyedChains: number[]; unknownChains: number[]; missing: string[] };
};

export type GasSurveyView = {
  homeChainId: number;
  chains: GasSurveyChain[];
  route: GasSurveyRoute;
};

/** POST /api/agents/:id/networks success body (201, or 200 when alreadyOnboarded). */
export type OnboardNetworkResult = {
  chainId: number;
  accountAddr: Address;
  createTx?: string;
  registerTx?: string;
  adopted?: boolean;
  alreadyOnboarded?: boolean;
};

/** Typed refusal reasons on the onboard POST (409) plus the 503 outage code. */
export type OnboardRefusalReason =
  | 'not_v4'
  | 'no_persisted_tuple'
  | 'home_chain'
  | 'already_onboarded'
  | 'guardian_mismatch'
  | 'tuple_prediction_mismatch'
  | 'mint_address_mismatch'
  | 'unregistered_chain'
  | 'multichain_unavailable';

/** GET /api/networks/:chainId/accounts/:accountAddr — owner-scoped per-chain account view. */
export type NetworkAccountView = {
  agent: { id: string; name: string; status: string; accountAddr: Address; chainId: number };
  requests: Json[];
};

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
  /** Detected settlement-asset metadata (read on-chain at originate). */
  feeTokenSymbol: string | null;
  feeTokenDecimals: number | null;
  deliverable: Json | null; // UNTRUSTED
  deliverableRoot: string | null;
  deliverableSummary: string | null; // UNTRUSTED
  acceptance: AcceptanceResult | null;
  verdict: 'accept' | 'reject' | null;
  rationaleRef: string | null;
  approvalId: string | null;
  settlementTx: string | null;
  /** Broadcast, receipt not yet resolved. Non-null means value may have moved. */
  settlementTxPending: string | null;
  poa: PoaRecord | null;
  blockedBy: string | null;
  createdAt: string;
  updatedAt: string;
};
