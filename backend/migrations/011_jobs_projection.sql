-- Phase 4 (spec §5): the ACP job runtime read-model + the owner-seeded job
-- spec registry. Both are RUNTIME state, NOT authority — the coordination
-- tables (links/delegations) stay generic (generality guard: no goal-schema
-- leaks into contracts/APIs/coordination). The chain remains the hard
-- settlement boundary; these tables only project what the runtime observed.
--
-- Schema-qualification is intentionally absent: the runner sets search_path
-- (production: public; tests: an ephemeral schema).

-- The owner-seeded job definition (F5): the operator defines the job a
-- requester runs — the requester EXECUTES it, never invents the question.
-- `source_ref` is the opaque handle the RequesterGoal.jobSpecSource points at.
-- The acceptance rule set (F2 — generic engine) travels WITH the spec so the
-- deterministic floor is resolvable server-side, never from model/envelope
-- text. The fee amount lives here too (F4 — fee from server state, never from
-- the model): bounded again by feeCapPerJob + the on-chain per-token caps.
CREATE TABLE job_specs (
  owner_addr text NOT NULL,
  source_ref text NOT NULL,
  spec        jsonb NOT NULL,   -- JobSpec (question/context/deliverableSchemaRef/acceptanceRef)
  acceptance  jsonb NOT NULL,   -- AcceptanceRuleSet (generic rule engine, F2)
  fee_amount_wei text NOT NULL, -- owner-defined fee (token base units), F4
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_addr, source_ref)
);

-- The job projection: one row per ACP job, updated as the lifecycle advances.
-- A runtime read model keyed by the app-supplied jobId (single-use, like
-- delegation ids). Deliverable is stored PLAINTEXT in hot state for the
-- evaluator to read (the owner-only ECIES copy on 0G Storage is the permanent
-- audit artifact); only hashes/roots/sigs enter the verified PoA (F-quar/L-1).
CREATE TABLE jobs (
  job_id uuid PRIMARY KEY,
  owner_addr text NOT NULL,
  requester_agent_id uuid NOT NULL REFERENCES agents(id),
  provider_agent_id  uuid NOT NULL REFERENCES agents(id),
  evaluator_agent_id uuid NOT NULL REFERENCES agents(id),
  status text NOT NULL CHECK (status IN (
    'originated','delivered','evaluating','verdict','awaiting_approval',
    'settling','settled','rejected','denied','failed')),
  spec jsonb NOT NULL,
  job_spec_hash text NOT NULL,
  requester_sig text NOT NULL,
  fee_token text NOT NULL,
  fee_amount_wei text NOT NULL,
  fee_recipient text NOT NULL,
  -- delivery (set when the provider delivers)
  deliverable jsonb,               -- PLAINTEXT hot copy (evaluator reads this)
  deliverable_root text,           -- 0G Storage Merkle root of the ECIES copy
  deliverable_summary text,        -- QUARANTINED-untrusted (F-quar)
  provider_sig text,
  acceptance jsonb,                -- AcceptanceResult of the deterministic floor
  -- verdict (set when the evaluator returns)
  verdict text CHECK (verdict IN ('accept','reject')),
  rationale_ref text,
  evaluator_sig text,
  -- settlement
  approval_id uuid,
  settlement_tx text,
  poa jsonb,                       -- the assembled multi-party PoA record (F7)
  blocked_by text,                 -- gate layer that blocked release, if any
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON jobs (requester_agent_id, status);
CREATE INDEX ON jobs (owner_addr, created_at DESC);
