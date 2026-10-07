-- Stage F / SF-2 — external Tier-2 agent binding.
--
-- A bound agent IS an `agents` row (`bind_mode='external'`) so it reuses the
-- ENTIRE SF-1/SF-3 enforcement spine unchanged — authenticateAgent (token →
-- agent), tool_rules FK, trace_records, approvals, the tool-gate. The only
-- difference is what a bound agent does NOT have: a session key, an audit key,
-- an on-chain chain-agent id, and (optionally) an on-chain account. Those
-- authority columns are relaxed to nullable; the Tier-2-only fields live in the
-- `bound_agents` side-table. Additive-only — backfill is a no-op (every
-- existing row is native: bind_mode stays NULL and all columns stay populated).
--
-- Zero-authority (F-2b) is BY CONSTRUCTION: a bound agent has no session_key_*,
-- so the runtime cannot start it (POST /start rejects bind_mode='external') and
-- there is no on-chain spend path to grant a treasury rule against. The gateway
-- egress proxy (SF-1/SF-3) is its sole, off-chain reach — governed identically
-- to a native agent's inference/tool traffic.

-- Relax the authority columns a bound agent legitimately lacks. (chain_agent_id
-- is already nullable in 001; left out here.) A native agent still supplies all
-- of these — nothing about the native path changes.
ALTER TABLE agents ALTER COLUMN session_key_addr DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN session_key_enc  DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN audit_pubkey     DROP NOT NULL;
-- account_addr: a zero-authority bound agent has nothing on-chain to anchor to
-- (STAGE-F-SF2-BUILD-PLAN §1.3 — on-chain account OPTIONAL at import). Left
-- NULL rather than a synthetic placeholder so it never collides in — nor is
-- cross-readable through — the owner-scoped UNIQUE(owner_addr, chain_id,
-- account_addr) index (021). getAgentByAccountAndChain(owner, chain, realAddr)
-- never matches a NULL-account bound row.
ALTER TABLE agents ALTER COLUMN account_addr DROP NOT NULL;

-- bind_mode: NULL = native (the only kind before SF-2); 'external' = Tier-2
-- bound. listActiveAgents filters `bind_mode IS DISTINCT FROM 'external'`; the
-- predicate is cheap (native rows are NULL) and the agents table is owner-scoped
-- small, so no dedicated index is warranted yet.
ALTER TABLE agents ADD COLUMN bind_mode text
  CHECK (bind_mode IS NULL OR bind_mode = 'external');

-- Tier-2-only fields for a bound agent. One row per bound agents row.
CREATE TABLE bound_agents (
  agent_id             uuid PRIMARY KEY REFERENCES agents(id),
  -- OPTIONAL reference to an on-chain LeashAccount the owner already has. NULL
  -- for a pure off-chain bound agent. This does NOT grant on-chain authority —
  -- the bound agent holds no session key for it (F-2b zero-authority).
  leashed_account_addr text,
  chain_id             bigint,
  -- argon2id(secret) of the bound agent's gateway token. The token itself rides
  -- agents.token_id/token_hash (so authenticateAgent resolves it unchanged);
  -- this mirror is kept for rotate/unbind bookkeeping on the Tier-2 side-table.
  gateway_token_hash   text NOT NULL,
  -- MCP tool scope granted at bind (array of canonical `server.tool` ids).
  mcp_scope            jsonb NOT NULL DEFAULT '[]',
  -- Stable external-facing tenant identifier. Structural tenant isolation is
  -- enforced by agent_id (every gateway/tool/trace read derives scope from the
  -- authenticated agent, never from client params — F-2b); tenant_key is the
  -- durable anchor the bind surface and audit trail reference.
  tenant_key           text NOT NULL UNIQUE,
  -- Bind-time choice (not a live toggle). SF-2 implements 'observe' only;
  -- 'passive'/'active' are declared at the bind screen with costs shown but
  -- behavior DEFERRED to SF-2′ (enum present day one → zero migration later).
  interaction_mode     text NOT NULL DEFAULT 'observe'
                         CHECK (interaction_mode IN ('observe', 'passive', 'active')),
  bind_mode            text NOT NULL DEFAULT 'external'
                         CHECK (bind_mode = 'external'),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bound_agents_account ON bound_agents (leashed_account_addr, chain_id)
  WHERE leashed_account_addr IS NOT NULL;
