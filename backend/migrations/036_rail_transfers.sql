-- AQ-FND M-4 — the cross-chain rail recovery state machine, as FIRST-CLASS TYPED
-- STATE (spec §M-4: "per-rail recovery/timeout as a first-class state — a no-fill
-- → refund → retry machine, not an error path").
--
-- One row per cross-chain value movement across a real rail (Chainlink CCIP for
-- every 0G leg; CCTP v2 for the Base/Eth/Arb USDC legs — D-5 as Dami ruled). The
-- row is what makes an un-filled transfer a RECONCILABLE state the recovery sweep
-- owns, exactly as `jobs.settlement_tx_pending` made an unresolved fee transfer
-- reconcilable instead of lost (migration 035). The mocks never had this — a
-- failed hop was an error path that dropped the funds' only handle.
--
-- Lifecycle (every transition is CAS-guarded in store/rail-transfers.ts):
--
--   initiated ──▶ source_confirmed ──▶ attested ──▶ filling ──▶ filled   (happy, TERMINAL ok)
--       │                                               │
--       │ source reverted / unrecoverable               │ dest never filled in the window
--       ▼                                               ▼
--     failed (TERMINAL)                               no_fill ──▶ recovering ──▶ filled | refunded
--                                                        ▲            │
--                                                        └── retry ───┘  (attempt_count++)
--
--   CCTP recovery is FORWARD-ONLY self-rescue (retain message bytes + dest gas,
--   re-submit the mint — M-4); CCIP recovery is refund-on-expiry / slow-fill.
--   `recovery_mode` records which, so the sweep drives the right leg.
--
-- G-9 strand: a route is only ENTERABLE with a funded destination-gas plan. That
-- is a NOT-NULL column here — a row cannot be initiated without one, so the
-- substrate refuses an un-prefunded route by construction (the DECISION to refuse
-- an unrecoverable route stays A3/A5 consumer logic; this is the on-DB guard).
--
-- Nullable off-chain proofs (attestation / message_bytes) are retained for the
-- forward-only mint self-rescue. search_path is set by the runner.

CREATE TABLE rail_transfers (
  rail_id            uuid PRIMARY KEY,
  agent_id           text NOT NULL,
  account_addr       text NOT NULL,              -- the agent's same-address leashed account (src == dest addr)
  rail               text NOT NULL CHECK (rail IN ('cctp', 'ccip')),
  recovery_mode      text NOT NULL CHECK (recovery_mode IN ('forward_mint', 'refund_expiry')),
  src_chain_id       integer NOT NULL,
  dest_chain_id      integer NOT NULL,
  asset              text NOT NULL,              -- the bridged token (lowercased); the budget key the caps bind on
  amount_wei         text NOT NULL,              -- base-units decimal string (BigInt-safe)
  status             text NOT NULL CHECK (status IN (
                       'initiated', 'source_confirmed', 'attested', 'filling',
                       'filled', 'no_fill', 'recovering', 'refunded', 'failed')),
  -- destination-gas plan (G-9): NON-NULL — no route is enterable without one.
  dest_gas_plan      jsonb NOT NULL,
  -- write-ahead tx handles (mirrors jobs.settlement_tx_pending — a broadcast hash
  -- is persisted BEFORE its receipt is waited on, so an unreadable receipt is
  -- reconcilable, never a lost transfer).
  src_tx             text,                       -- the source leg (depositForBurn / ccipSend)
  dest_tx            text,                       -- the destination leg (mint / ccip-exec), set on 'filling'
  refund_tx          text,                       -- the refund leg, set when recovery refunds
  attestation        text,                       -- CCTP Circle attestation (retained for the mint)
  message_bytes      text,                       -- CCTP message / CCIP messageId (retained for forward self-rescue)
  min_output_wei     text,                       -- slippage floor asserted on the leg (NULL for 1:1 lock-mint rails)
  attempt_count      integer NOT NULL DEFAULT 0, -- recovery attempts so far
  max_attempts       integer NOT NULL DEFAULT 3,
  next_attempt_at    timestamptz,                -- when the recovery sweep may try again (backoff)
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rail_transfers_agent_idx ON rail_transfers (agent_id, created_at DESC);

-- The recovery sweep's work set: anything not in a terminal state, due for a look.
-- (terminal = filled | refunded | failed). Ordered by when it may next be worked.
CREATE INDEX rail_transfers_open_idx
  ON rail_transfers (next_attempt_at)
  WHERE status IN ('initiated', 'source_confirmed', 'attested', 'filling', 'no_fill', 'recovering');
