-- 019: SE-2 runtime one-shot-consume (SD-E2, flips F-D2).
--
-- Stage D proved approve-once only as an on-chain PRIMITIVE (authorizeOnce sets
-- oneShotAuthEta[callHash], consumed delete-on-use) — the runtime recorded the
-- decision but never submitted, so the one-shot sat unconsumed until expiry.
-- SE-2 builds the missing runtime path: after the owner picks approve_once, a
-- runtime action auto-retries the originally-refused call and consumes the
-- on-chain one-shot exactly once.
--
-- To retry we need the EXACT refused bytes (target, value, data) the owner
-- authorized via callHash — keccak is one-way, so the callHash alone can't
-- reconstruct them. They are server-authored (from buildGovernedCall, never
-- model text) and bound by the on-chain callHash; persisting them is safe.
--
-- The consumption sub-state is the SE-2 audit trail (spec §5): it lets a replay
-- be refused OFF-CHAIN too (a second consume attempt sees `consumed`) and shows
-- consume-once in the audit stream. The on-chain oneShotAuthEta[callHash] stays
-- the sole enforcement authority.
ALTER TABLE capability_requests
  ADD COLUMN call_target     text,        -- exact executeCall target (lowercased)
  ADD COLUMN call_value      text,        -- exact msg.value (base-10 wei string)
  ADD COLUMN call_data       text,        -- exact calldata (0x…) bound by call_hash
  -- consume lifecycle: NULL (not attempted) → consuming (claimed) → consumed |
  -- aborted (stale grant/revoke/expiry — re-claimable) | failed (revert/flake —
  -- terminal, fail-safe: never an auto-retry loop, never a phantom action).
  ADD COLUMN consume_status  text
                 CHECK (consume_status IN ('consuming','consumed','aborted','failed')),
  ADD COLUMN consume_tx_hash text,
  ADD COLUMN consumed_at     timestamptz;
