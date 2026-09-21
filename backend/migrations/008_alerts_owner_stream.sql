-- Phase 3 (spec §5): the daily loop — alerts, owner settings, Telegram link
-- tokens, and the per-OWNER hash-chained record stream (the 0G-logged loop,
-- 00 §1a) with its batches + cursor. owner_records mirrors trace_records'
-- discipline (append-only trigger; restricted-role grants live in
-- scripts/provision-runtime-role.mjs — roles are cluster-global).

CREATE TABLE owner_settings (
  owner_addr        text PRIMARY KEY,
  telegram_chat_id  text,
  telegram_linked_at timestamptz,
  alert_prefs       jsonb NOT NULL DEFAULT '{}',   -- per-kind channel toggles
  digest_hour_utc   int,
  digest_optout     boolean NOT NULL DEFAULT false,
  digest_cursor     jsonb,                         -- ts + per-agent seq high-water marks + balance snapshots
  stream_pubkey     text,                          -- owner-stream ECIES pubkey (set-once; rotation deferred)
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_link_tokens (
  token_hash text PRIMARY KEY,
  owner_addr text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_addr  text NOT NULL,
  agent_id    uuid REFERENCES agents(id),
  link_id     uuid REFERENCES links(id),
  class       text NOT NULL CHECK (class IN ('decision','info')),
  kind        text NOT NULL,
  status      text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','resolved','dismissed')),
  summary     text NOT NULL,
  refs        jsonb NOT NULL DEFAULT '{}',
  count       int NOT NULL DEFAULT 1,              -- coalesced kinds increment
  dedup_key   text,
  telegram_message_id text,                        -- for edit-on-resolve/expiry
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution  text,                                -- approve | deny | expired | dismissed
  resolved_via text                                -- app | telegram | system
);

-- Dedup: ONE open row per (owner, dedup_key); concurrent same-key emits land
-- as a single row with count incremented (INSERT ... ON CONFLICT upsert).
CREATE UNIQUE INDEX alerts_open_dedup ON alerts (owner_addr, dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('unread','read');
CREATE INDEX alerts_owner_status_idx ON alerts (owner_addr, status, created_at DESC);
CREATE INDEX alerts_refs_approval_idx ON alerts ((refs->>'approvalId')) WHERE refs ? 'approvalId';

-- The owner-level hash-chained record stream (mirrors trace_records).
CREATE TABLE owner_records (
  owner_addr text NOT NULL,
  seq        bigint NOT NULL,
  prev_hash  text NOT NULL,
  hash       text NOT NULL,
  ts         timestamptz NOT NULL,
  kind       text NOT NULL,                        -- alert | alert_resolved | digest
  record     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_addr, seq)
);

CREATE FUNCTION forbid_owner_record_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'owner_records is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER owner_records_append_only
  BEFORE UPDATE OR DELETE ON owner_records
  FOR EACH ROW EXECUTE FUNCTION forbid_owner_record_mutation();

-- Same TRUNCATE closure as 007 gave trace_records (every non-admin role).
CREATE TRIGGER owner_records_no_truncate
  BEFORE TRUNCATE ON owner_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_owner_record_mutation();

-- Batches + cursor: audit_batches/audit_cursor semantics keyed by owner_addr.
CREATE TABLE owner_audit_batches (
  batch_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_addr  text NOT NULL,
  seq_from    bigint NOT NULL,
  seq_to      bigint NOT NULL,
  merkle_root text NOT NULL,
  storage_tx  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE owner_audit_cursor (
  owner_addr       text PRIMARY KEY,
  last_batched_seq bigint NOT NULL DEFAULT -1
);
