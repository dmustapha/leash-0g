-- Phase 3 (spec §3b Telegram): durable single-use callback tokens for inline
-- Approve/Deny buttons. callback_data carries an opaque short token — NEVER a
-- raw approvalId — resolved server-side; used_at makes each token single-use
-- (replay-proof) and restart-proof (survives redeploys, unlike memory).
CREATE TABLE telegram_callbacks (
  token_hash  text PRIMARY KEY,
  owner_addr  text NOT NULL,
  approval_id uuid NOT NULL REFERENCES approvals(id),
  alert_id    uuid NOT NULL REFERENCES alerts(id),
  decision    text NOT NULL CHECK (decision IN ('approve','deny')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);

CREATE INDEX telegram_callbacks_alert_idx ON telegram_callbacks (alert_id);
