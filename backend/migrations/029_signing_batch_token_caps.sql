-- Stage F′ / FP-4 Slice-5 — Permit2 `PermitBatchTransferFrom` read-model support. A batch rule carries an
-- owner-reviewed per-token cap ALLOWLIST (the off-chain mirror of the on-chain committed `TokenCap[]`;
-- on-chain the wall stores only `keccak256(abi.encode(caps))`). The pre-Slice-5 signing_rules row stored a
-- single `token`/`per_intent_cap` — insufficient for a multi-token batch. Additive-only (unlike Slice-4,
-- which added no owner-stored vector; §5.6 / G6): a narrow jsonb column, defaulting empty so every existing
-- (non-batch) row is untouched. DISPLAY + JIT-workflow state only — the on-chain wall is the sole authority.
ALTER TABLE signing_rules
  ADD COLUMN token_caps jsonb NOT NULL DEFAULT '[]'::jsonb; -- [{token, cap}] lowercased token, base-units cap
