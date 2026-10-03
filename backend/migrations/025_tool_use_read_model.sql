-- Stage F / SF-3 — governed tool-use read-model (mirror of migration 017's
-- capability tables). DISPLAY + JIT-workflow state ONLY — the gateway egress
-- proxy is the sole authority for tool-use enforcement (there is NO on-chain
-- backstop for an off-chain tool call, STAGE-F §8). Nothing here gates a tool;
-- it mirrors what the owner granted so the cockpit can render the envelope and
-- the JIT cards. Additive-only.

-- tool_rules: the owner's standing per-tool grant (server mirror of a ToolRule).
CREATE TABLE tool_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id),
  chain_id        bigint NOT NULL,
  owner_addr      text NOT NULL,
  tool_id         text NOT NULL,                     -- canonical `server.tool`, lowercased
  allowed         boolean NOT NULL DEFAULT true,
  sensitive       boolean NOT NULL DEFAULT false,
  per_call_policy jsonb,                             -- { maxArgBytes?, recipientAllowlist? }
  source          text NOT NULL DEFAULT 'custom',    -- 'custom' | 'preset:<key>' | 'jit'
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('proposed','active','removed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, tool_id)
);
CREATE INDEX tool_rules_agent ON tool_rules (agent_id);

-- tool_presets: which tool presets an owner applied to an agent (display).
CREATE TABLE tool_presets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id),
  chain_id    bigint NOT NULL,
  owner_addr  text NOT NULL,
  preset_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- tool_requests: the L2 JIT workflow store (quarantined), mirror of capability_requests.
CREATE TABLE tool_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id),
  chain_id     bigint NOT NULL,
  owner_addr   text NOT NULL,
  tool_id      text NOT NULL,
  decoded      jsonb NOT NULL,                       -- QUARANTINED, labeled UNVERIFIED (display/audit)
  triggers     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ToolTrigger[] (sensitive/new_recipient/over_arg_size)
  call_hash    text NOT NULL,                        -- keccak256(chainId, toolId, canonical(args))
  args         jsonb NOT NULL,                       -- the exact GUARDED args to forward on approve
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved_once','always_allowed','denied','expired')),
  approval_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE UNIQUE INDEX tool_requests_pending_uk
  ON tool_requests (agent_id, call_hash) WHERE status = 'pending';
CREATE INDEX tool_requests_agent ON tool_requests (agent_id);
