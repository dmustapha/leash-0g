-- Stage F′ / FP-2 — governed-signing read-model (mirror of migration 025's
-- tool-use tables). DISPLAY + JIT-workflow + arm-reconcile state ONLY — the
-- on-chain LeashAccountV5 `authorizeSigningIntent`/`isValidSignature` wall is the
-- sole enforcement guarantee (00 §6c). Nothing here gates a signature; it mirrors
-- what the owner granted so the cockpit can render the signing envelope + JIT
-- cards, and tracks armed intents so a tighten's epoch-bump surfaces as stale
-- (FP-CARRY-4 / FP-CARRY-5 read-model reconcile). Additive-only.

-- signing_rules: the owner's standing per-descriptor grant (server mirror of a SigningRule).
CREATE TABLE signing_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            uuid NOT NULL REFERENCES agents(id),
  chain_id            bigint NOT NULL,
  owner_addr          text NOT NULL,
  descriptor_id       bigint NOT NULL,                 -- on-chain signingIntentPolicy key
  descriptor_key      text NOT NULL,                   -- human id e.g. 'erc2612.permit'
  token               text NOT NULL,                   -- the per-token budget the amount binds to
  per_intent_cap      text NOT NULL,                   -- base-units (numeric-as-text)
  max_deadline_window bigint NOT NULL,                 -- seconds; 0 disables the descriptor
  spender_set         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- lowercased 0x spenders
  source              text NOT NULL DEFAULT 'custom',  -- 'custom' | 'jit'
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('proposed','active','removed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, descriptor_id)
);
CREATE INDEX signing_rules_agent ON signing_rules (agent_id);

-- signing_requests: the L2 JIT workflow store (quarantined), mirror of tool_requests.
CREATE TABLE signing_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES agents(id),
  chain_id      bigint NOT NULL,
  owner_addr    text NOT NULL,
  descriptor_id bigint NOT NULL,
  decoded       jsonb NOT NULL,                        -- QUARANTINED, labeled UNVERIFIED (human decode)
  triggers      jsonb NOT NULL DEFAULT '[]'::jsonb,    -- SigningTrigger[]
  request_hash  text NOT NULL,                         -- keccak256(chainId, descriptorId, spender, amount, deadline)
  intent        jsonb NOT NULL,                        -- the built typed-data + ordered fields to arm on approve
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved_once','always_allowed','denied','expired')),
  approval_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE UNIQUE INDEX signing_requests_pending_uk
  ON signing_requests (agent_id, request_hash) WHERE status = 'pending';
CREATE INDEX signing_requests_agent ON signing_requests (agent_id);

-- signing_arms: the armed-intent read-model (FP-CARRY-4/5 reconcile). Mirrors what
-- the session key armed on-chain so the cockpit never shows a dead arm as live: a
-- signing-relevant tighten/remove/revoke bumps the on-chain signingEpoch, and
-- reconcileSigningArms marks every arm snapshotting an older epoch 'stale'.
CREATE TABLE signing_arms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES agents(id),
  chain_id      bigint NOT NULL,
  descriptor_id bigint NOT NULL,
  digest        text NOT NULL,                         -- the EIP-712 digest armed on-chain
  spender       text NOT NULL,
  amount        text NOT NULL,
  deadline      bigint NOT NULL,
  epoch         bigint NOT NULL,                       -- signingEpoch snapshot at arm time
  status        text NOT NULL DEFAULT 'armed'
                  CHECK (status IN ('armed','stale','disarmed','expired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, digest)
);
CREATE INDEX signing_arms_agent ON signing_arms (agent_id);
