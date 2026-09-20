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
 *  topped up to `targetBalanceWei`, sending at most `topUpWei` per top-up. */
export type GoalInput = {
  beneficiary: Address;
  targetBalanceWei: string; // wei
  topUpWei: string; // wei
  model?: string;
};

export type CreateAgentRequest = {
  name: string;
  policy: PolicyInput;
  allowlist: Address[];
  goal: GoalInput;
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

export type AgentDetail = {
  status: AgentStatus;
  policy: PolicyInput & { allowlist: Address[] };
  accountBalance: string; // wei
  computeBalance?: string;
  sessionExpiry: number; // unix seconds
  addresses: { account: Address; sessionKey: Address; owner: Address };
  /** Opaque KEK-wrapped audit privkey blob stored blind at create (serialized EncryptedBlob).
   *  Not in the §4 table; the FE also accepts the downloaded backup file as the unlock source. */
  encryptedAuditKey?: string;
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
  | { type: 'status'; status: AgentStatus; ts?: string };

export type TraceRecord = {
  agentId: string;
  seq: number;
  prevHash: Hex;
  ts: string;
  kind: 'inference' | 'action' | 'decision' | 'consent' | 'modify' | 'block' | 'revoke';
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
