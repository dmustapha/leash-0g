-- LEASH Phase 1 schema (spec §5). Schema-qualification is intentionally absent:
-- the runner sets search_path (production: public; tests: an ephemeral schema).

CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_agent_id numeric,                 -- AgentRegistry agentId (registered by ops key)
  -- owner_addr is the AUTHORITY for owner-API access. The on-chain registry
  -- entry is registered by the LEASH ops key (register() msg.sender = ops), so
  -- the registry "owner" is ops; the user's Privy wallet address stored here is
  -- what governs the LeashAccount (contract owner) and all owner routes.
  owner_addr    text NOT NULL,
  account_addr  text NOT NULL,
  session_key_addr text NOT NULL,
  session_key_enc  text NOT NULL,         -- AES-256-GCM(KEY_ENCRYPTION_SECRET) blob
  audit_pubkey  text NOT NULL,            -- ECIES pubkey; privkey is owner-held only
  token_id      text NOT NULL UNIQUE,     -- O(1) gateway token lookup
  token_hash    text NOT NULL,            -- argon2id(secret)
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  gateway_rules jsonb NOT NULL DEFAULT '[]',
  goal          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trace_records (
  agent_id   uuid NOT NULL REFERENCES agents(id),
  seq        bigint NOT NULL,
  prev_hash  text NOT NULL,
  hash       text NOT NULL,
  ts         timestamptz NOT NULL,
  kind       text NOT NULL,
  record     jsonb NOT NULL,              -- the full canonical TraceRecord (incl. hash)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, seq)
);

-- Append-only enforcement: trace_records can never be updated or deleted.
CREATE FUNCTION forbid_trace_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trace_records is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trace_records_append_only
  BEFORE UPDATE OR DELETE ON trace_records
  FOR EACH ROW EXECUTE FUNCTION forbid_trace_mutation();

CREATE TABLE approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id),
  request_ref jsonb NOT NULL,
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied')),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);

CREATE TABLE audit_batches (
  batch_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id),
  seq_from   bigint NOT NULL,
  seq_to     bigint NOT NULL,
  merkle_root text NOT NULL,
  storage_tx text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cursor for the async audit batcher (keeps trace_records strictly append-only).
CREATE TABLE audit_cursor (
  agent_id         uuid PRIMARY KEY REFERENCES agents(id),
  last_batched_seq bigint NOT NULL DEFAULT -1
);

-- agent_checkpoints (spec §5): the LangGraph PostgresSaver manages its own
-- checkpoint tables (checkpoints, checkpoint_blobs, checkpoint_writes) in this
-- schema via saver.setup(); no DDL needed here.
