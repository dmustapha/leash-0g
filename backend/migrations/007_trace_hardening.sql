-- C-6 (Phase 2): TRUNCATE was the one mutation path the Phase-1 append-only
-- trigger (UPDATE/DELETE) did not cover. Statement-level BEFORE TRUNCATE
-- closes it for every role, superuser included.
CREATE TRIGGER trace_records_no_truncate
  BEFORE TRUNCATE ON trace_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_trace_mutation();

-- The restricted runtime DB role (no DDL / no TRUNCATE / no UPDATE / DELETE on
-- trace_records) is provisioned by scripts/provision-runtime-role.mjs — roles
-- are cluster-global and need the Neon ADMIN connection once, so they cannot
-- live in a per-schema migration. See backend/docs/RUNTIME-DB-ROLE.md.
