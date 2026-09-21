# Restricted runtime DB role (C-6)

The backend connects to Postgres as `leash_runtime` — a role with **no DDL**,
**no TRUNCATE**, and **no UPDATE/DELETE on `trace_records`** (append-only at the
grant layer, on top of the 001 UPDATE/DELETE and 007 TRUNCATE triggers that
block everyone).

## Provisioning (one-time, Neon ADMIN connection)

```bash
node scripts/provision-runtime-role.mjs "<ADMIN_DATABASE_URL>"
```

Prints the runtime connection string. Then:

1. **Render / CI:** set `DATABASE_URL` = the printed runtime URL.
2. **Keep the admin URL** as `MIGRATE_DATABASE_URL` (Render + CI): boot-time
   migrations need DDL, which the runtime role deliberately lacks. When
   `MIGRATE_DATABASE_URL` is unset the app migrates over `DATABASE_URL`
   (admin-URL setups, tests).

The script is idempotent — re-running rotates the role password and re-prints
the URL (update the env values after a rotation).

## Rollback (mid-deploy failure is not a lockout)

Restore the previous `DATABASE_URL` value on Render/CI (the admin role kept
every right it had) and redeploy. The role itself can stay — it grants nothing
to anyone else — or be dropped:

```sql
DROP OWNED BY leash_runtime; DROP ROLE leash_runtime;
```

## What enforces what

| Threat | Enforced by |
|---|---|
| UPDATE/DELETE on trace_records | 001 trigger (everyone) + missing grant (role) |
| TRUNCATE trace_records | 007 BEFORE TRUNCATE trigger (everyone) + no TRUNCATE grant (role) |
| DDL (ALTER/DROP/CREATE) from a compromised app | role has USAGE only on the schema, owns nothing |

Verified in CI: `test/integration/db-role.test.ts` provisions the role against
the ephemeral test schema and asserts every denial as the role, plus that
normal app queries still work.
