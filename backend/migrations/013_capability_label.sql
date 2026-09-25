-- Phase-5 (D-B9): a freeform "what it's for" label on an agent. Elevation
-- SUGGESTS it; the owner edits it; the cockpit shows it. Deliberately INERT —
-- no taxonomy, no filtering, no discovery UI (07 S17/S18 — that is Horizon). A
-- nullable seed for future discovery, nothing consumes it beyond display today.
-- Idempotent so it is a no-op on any DB that already has the column.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capability_label text;
