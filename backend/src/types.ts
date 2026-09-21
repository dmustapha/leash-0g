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
  | 'config'; // owner config change (gatewayRules, link changes) — original+effective

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
  createdAt: string;
}

export interface AgentGoal {
  beneficiary: string;
  targetBalanceWei: string;
  topUpWei: string;
  model?: string | undefined;
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

export interface ApprovalRow {
  id: string;
  agentId: string;
  requestRef: Json;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}
