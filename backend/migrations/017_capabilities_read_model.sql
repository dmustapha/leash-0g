-- Stage D (Governed Calldata, spec §5): the capabilities READ MODEL. Like the
-- Phase-4 `jobs` (011) and Phase-5.6 `chains` (016) projections, this is DISPLAY
-- + WORKFLOW state, NOT authority. The on-chain LeashAccountV4 account is the
-- SOLE source of truth for enforcement (live-chain-read discipline, `07` Phase-1);
-- nothing here gates money. These tables let the cockpit render the granted
-- envelope, the applied presets, and the quarantined JIT (L2) request workflow.
--
-- search_path is set by the runner (production: public; tests: an ephemeral
-- schema) — schema-qualification is intentionally absent.

-- A server MIRROR of an on-chain governed-call grant (CallRule), for display.
-- status mirrors the on-chain lifecycle for DISPLAY only:
--   proposed = owner signed proposeCallRule → loosen-timelock in flight on-chain
--   active   = applyCallRule landed (or an instant path) → the rule is live
--   removed  = tightened away / removed
-- The owner signs every state change client-side via the Privy owner wallet
-- (the same authority path as proposePolicy/proposeAllowlist since Phase 1) —
-- the backend NEVER holds owner authority and NEVER submits a grant tx.
CREATE TABLE capability_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id),
  owner_addr      text NOT NULL,
  target          text NOT NULL,     -- lowercased 0x contract address
  selector        text NOT NULL,     -- lowercased 0x + 8 hex (4-byte selector)
  recipient_mode  text NOT NULL CHECK (recipient_mode IN ('self','allowlist')),
  spender_set     jsonb NOT NULL DEFAULT '[]'::jsonb,
  per_call_cap    text NOT NULL,     -- base-units decimal string
  window_cap_call text NOT NULL,     -- base-units decimal string
  codehash        text,              -- optional ERC-1967 impl codehash pin (C-05)
  source          text NOT NULL DEFAULT 'custom', -- 'custom' | 'preset:<key>' | 'jit'
  status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','active','removed')),
  tx_hash         text,              -- the owner-signed on-chain tx (client-side)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- one row per (agent,target,selector) — a re-grant updates in place.
  UNIQUE (agent_id, target, selector)
);
CREATE INDEX capability_grants_agent ON capability_grants (agent_id);
CREATE INDEX capability_grants_owner ON capability_grants (owner_addr, created_at DESC);

-- Which presets an owner has applied to an agent (display: "this agent runs
-- DeFi Trader"). A preset is off-chain sugar over the grant grammar (D-9); the
-- concrete rules land as capability_grants rows with source='preset:<key>'.
CREATE TABLE capability_presets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id),
  owner_addr  text NOT NULL,
  preset_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capability_presets_agent ON capability_presets (agent_id, created_at DESC);

-- The L2 JIT workflow store (D-8). A novel call raises exactly ONE quarantined
-- request. `decoded` holds the QUARANTINED, sanitized, labeled-UNVERIFIED intent
-- (Phase-3 pattern) — it is NEVER executed and NEVER trusted as authority; it is
-- display + audit only. The owner decides approve-once / always-allow / deny;
-- a grant decision maps to an owner-signed on-chain tx (authorizeOnce /
-- proposeCallRule) — the session key can never widen itself off-chain.
CREATE TABLE capability_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id),
  owner_addr   text NOT NULL,
  decoded      jsonb NOT NULL,
  novelty      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- keccak256(abi.encode(target, selector, data, value)) — the exact one-shot key
  -- an approve-once authorization is bound to (D-7), byte-identical on-chain.
  call_hash    text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved_once','always_allowed','denied','expired')),
  approval_id  uuid,               -- the approval row riding the shared consent rail
  tx_hash      text,               -- owner-signed authorizeOnce / proposeCallRule tx
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX capability_requests_agent ON capability_requests (agent_id, created_at DESC);
CREATE INDEX capability_requests_owner ON capability_requests (owner_addr, created_at DESC);
-- Idempotency (D-8): at most ONE pending request per (agent, call_hash) — a novel
-- call raises exactly one request, never a duplicate storm on ret/repeat detect.
CREATE UNIQUE INDEX capability_requests_pending_uk
  ON capability_requests (agent_id, call_hash) WHERE status = 'pending';
