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

export type AgentGoal = GoalInput | SentinelGoal | ExecutorGoal;

export type CreateAgentRequest = {
  name: string;
  policy: PolicyInput;
  allowlist: Address[];
  goal: AgentGoal;
  auditPubKey: string; // hex, no 0x prefix per contract
  /** Opaque AES-GCM blob of the audit privkey; server stores it blind. */
  encryptedAuditKey: string;
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
export type AgentSummary = {
  agentId: string;
  name: string;
  status: 'active' | 'revoked';
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
