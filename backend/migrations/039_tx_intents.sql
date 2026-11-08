-- AQ-FND S1 (WP-F) — the transaction INTENT LEDGER.
--
-- Every on-chain write made with an agent's session key is recorded here BEFORE it is
-- broadcast (raw signed bytes + hash + nonce), so that a crash, a dropped receipt, a null
-- receipt or a concurrent sender can never turn into a second payment: the next process
-- reconciles from this row and the chain, it never rebuilds a send from scratch.
--
-- Lifecycle:  intent -> signed -> broadcast -> mined -> finalized
--   side exits: failed (never broadcast), reverted (mined, status 0), dropped, needs_review
--   (nonce consumed by an unknown tx — a human decides, never auto-retried), superseded (replaced).
--
-- Database-enforced safety (not only an in-process mutex):
--   * (agent_id, idem_key) unique: the same logical send can never be recorded twice.
--   * one un-mined tx per (key, chain): partial unique index over status IN (signed, broadcast).
--   * one live tx per (key, chain, nonce).
-- Additive only; nothing existing is altered.

CREATE TABLE tx_intents (
  intent_id        uuid PRIMARY KEY,
  agent_id         text NOT NULL,
  chain_id         integer NOT NULL,
  key_addr         text NOT NULL,
  account_addr     text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('transfer', 'token_transfer', 'call', 'sign_arm')),
  idem_key         text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL CHECK (status IN
                     ('intent', 'signed', 'broadcast', 'mined', 'finalized', 'reverted', 'failed', 'dropped', 'needs_review', 'superseded')),
  nonce            bigint,
  tx_hash          text,
  raw_tx           text,
  gas_limit        numeric,
  max_fee_per_gas  numeric,
  max_priority_fee_per_gas numeric,
  rebroadcasts     integer NOT NULL DEFAULT 0,
  bumps            integer NOT NULL DEFAULT 0,
  prev_hashes      text[] NOT NULL DEFAULT '{}',
  replaced_by      uuid,
  error_class      text,
  error_text       text,
  mined_block      bigint,
  finalized_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tx_intents_idem ON tx_intents (agent_id, idem_key);
CREATE UNIQUE INDEX tx_intents_one_unmined ON tx_intents (key_addr, chain_id) WHERE status IN ('signed', 'broadcast');
CREATE UNIQUE INDEX tx_intents_live_nonce ON tx_intents (key_addr, chain_id, nonce)
  WHERE nonce IS NOT NULL AND status IN ('signed', 'broadcast', 'mined', 'finalized');
CREATE INDEX tx_intents_open ON tx_intents (status, updated_at) WHERE status IN ('intent', 'signed', 'broadcast', 'mined', 'needs_review');
CREATE INDEX tx_intents_agent ON tx_intents (agent_id, created_at DESC);
