-- SE-7 (E-7 second-chain onboarding): per-chain PRESENCE of an agent's leashed
-- account. The agents row stays the HOME-chain anchor (agents.chain_id,
-- migration 020/021); onboarding the SAME agent onto another chain (replaying
-- the persisted account_create_tuple + account_salt so the account lands at the
-- SAME CREATE2 address, SD-E9) records a row here — one row per (agent, chain).
-- AgentRegistry is deployed PER CHAIN (SE-7 decision, RESULTS "Next-phase
-- needs"): chain_agent_id is that chain's registry id for the account.
-- search_path is set by the runner (public / ephemeral test schema).

CREATE TABLE agent_chain_deployments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id),
  chain_id     integer NOT NULL,
  -- Always the agent's SAME-ADDRESS account (byte-exact tuple replay); the
  -- lowercase CHECK mirrors migration 021's canonical-storage guarantee.
  account_addr text NOT NULL CHECK (account_addr = lower(account_addr)),
  -- Zero-hash when a pre-existing deterministic deploy was ADOPTED (M-02).
  create_tx    text NOT NULL,
  register_tx  text NOT NULL,
  chain_agent_id numeric,
  adopted      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One presence row per (agent, chain) — re-onboarding is idempotent at the
  -- service layer and impossible to double-record at the DB layer.
  CONSTRAINT agent_chain_deployments_agent_chain UNIQUE (agent_id, chain_id)
);

CREATE INDEX agent_chain_deployments_chain_account
  ON agent_chain_deployments (chain_id, account_addr);
