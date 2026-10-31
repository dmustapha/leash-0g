// The four objection classes the Skeptic may raise. Each binds to one DevSecOps stage.
export type ObjectionType = 'SECURITY' | 'REGRESSION' | 'CONTRACT' | 'SCOPE';
export type LifecycleStage = 'verify' | 'secure' | 'release' | 'monitor';
export type ObjectionStatus = 'open' | 'resolved' | 'withdrawn';
export type Verdict = 'AGREE' | 'NO_AGREE';

// An evidence demand is the machine-checkable condition that closes an objection.
export interface EvidenceDemand {
  stage: LifecycleStage;      // which provider verifies it
  check: string;              // provider-specific selector (test name, scan target, env id, url)
  expect: string;             // the asserted outcome ("pass", "clean", "healthy", "200")
}

export interface Objection {
  id: string;                 // stable id, e.g. "obj-1"
  type: ObjectionType;
  claim: string;              // the Skeptic's natural-language concern
  evidence_demand: EvidenceDemand;
  status: ObjectionStatus;
  resolution_ref?: string;    // commit SHA / job URL / artifact hash that resolved it
}

export interface Round {
  n: number;
  proposer: string;           // Proposer's argument this round
  skeptic: string;            // Skeptic's response this round
  objections: Objection[];    // objections as they stand after this round
}

export interface ConcordEntry {
  mr_iid: number;
  head_sha: string;           // the commit the verdict is bound to
  rounds: Round[];
  verdict: Verdict;
  prev_hash: string;          // entry_hash of the previous ledger entry ("" for genesis)
  entry_hash: string;         // sha256 over the canonicalized entry (excluding entry_hash)
  created_at: string;         // ISO-8601
}

export interface ProviderResult {
  satisfied: boolean;
  evidence_ref: string;       // resolvable pointer: job URL, exit code+hash, http status+ts
  detail?: string;
}
