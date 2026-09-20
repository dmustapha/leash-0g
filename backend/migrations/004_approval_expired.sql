-- Terminal 'expired' approval state: broker timeouts transition pending →
-- expired (never silently dropped) and append a consent-class trace record
-- with decision 'expired', so timeouts are chain-visible.
ALTER TABLE approvals DROP CONSTRAINT approvals_state_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_state_check
  CHECK (state IN ('pending','approved','denied','expired'));
