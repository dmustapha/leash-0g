# RH2 — Gate-② review kickoff (independent, do NOT auto-proceed to packaging)

**Branch:** `hackathon-robinhood` @ `87382d6` (off `main`). **Convention:** scope→OK→build→Gate-②.
**Scope note:** the slice went BEYOND config-only (a tested backend capability-factory seam landed,
Dami-approved "best path"), so Gate-② is wider than the spec's original plan: it now includes a
code-review of the touched files + a security-auditor DELTA on the new code — not config-only.

## What to verify (reconvene in a review chat; verify independently via subagents)

### 1. Re-run the drills (relay up: `node contracts/rpc-relay.cjs`; `cd backend`)
- `npx tsx scripts/rh-deploy-prod-factory.ts` → D1 3/3 (idempotent SKIP; codehash MATCH 0x4771f057…f325).
- `npx tsx scripts/rh-onboard-sameaddr-d2.ts` → D2 3/3 (RH==Base prediction; mint-at-prediction; mutated divergence).
- `npx tsx scripts/rh-owner-ops-d3.ts` → D3 4/4 (policy/revoke/rearm/Blockscout).
- `npx tsx scripts/rh-hero-staging-d4.ts` → D4 2/2 (band latch ON; drill 5/5).
- `npx tsx scripts/rh-capability-hero-d5.ts` → D5 5/5 (capability-factory create wire).
- Evidence JSONs under `docs/evidence/rh-*.json`.

### 2. Tests
- `npx vitest run test/unit/rh2-capability-factory.test.ts` → 9/9.
- `npx vitest run test/unit` → 424/424 (regression). `npx tsc --noEmit` clean.
- `npx vitest run test/integration/se7-onboarding.test.ts` → 13/13 (typed refusals — needs DB).

### 3. On-chain / live
- Blockscout: 0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f verified on RH 46630, codehash 0x4771f057…f325.
- Live Render EXTRA_CHAINS factoryV4Addr == prod; healthz ok; registry unchanged 0xf29435…BB2f.

### 4. Code-review (touched files)
- `backend/src/chain/registry.ts` (getCapabilityFactory, getChainOpsForFactory + cache)
- `backend/src/config.ts` (capabilityFactories parse: fail-loud, ≤8 bound, lowercase)
- `backend/src/api/owner-routes.ts` (POST /api/agents capability selection; OwnerChainRegistry iface)

### 5. Security-auditor DELTA (new code only)
Load-bearing invariants to confirm:
- **No arbitrary-factory injection:** `capability` is a NAMED KEY; the factory ADDRESS comes only from
  operator config; `getChainOpsForFactory` default-denies any off-config address. A caller cannot make
  the deployer mint through an attacker factory.
- **Default path byte-identical** when `capability` is unset (prod factory lane reused).
- **Bounded + fail-loud** operator config (L-02/L-03 posture preserved).

## Blocking carries (must be stated in the review verdict)
- **NO mainline merge in-sprint** (binding post-deadline gate). Production auto-deploys from `main`, so the
  in-cockpit band-hero CREATE is NOT live — it ships post-gate / demoable on a branch build
  (`docs/HACKATHON-RH2-B4-LIVE-STEPS.md`). Only B1's env-only same-address flip is live.
- **B4 live UI run** (onboard + band-hero create + fleet-visibility) = demo evidence, pending Dami's Privy
  session on a branch backend; the machine-verified halves (D2/D4/D5) already stand.

## On APPROVE
Emit the packaging kickoff (public repo, demo video ≤3 min, HackQuest Details) — a SEPARATE phase.
Deadline 2026-10-04 EOD (confirmed flexible). Dami is the gate; nothing auto-proceeds.
