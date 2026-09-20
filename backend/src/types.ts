import type { Json } from './crypto/canonical.js';

export type Hex = `0x${string}`;

/** Core trace types — spec §4, verbatim shape. */
export type TraceKind = 'inference' | 'action' | 'decision' | 'consent' | 'modify' | 'block' | 'revoke';

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
  decision?: 'approve' | 'deny';
  decidedBy?: 'owner';
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
  decision: 'approve' | 'deny';
  decidedBy: 'owner';
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
  createdAt: string;
}

export interface AgentGoal {
  beneficiary: string;
  targetBalanceWei: string;
  topUpWei: string;
  model?: string | undefined;
}

export interface ApprovalRow {
  id: string;
  agentId: string;
  requestRef: Json;
  state: 'pending' | 'approved' | 'denied';
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}
