# Runbook — D-JOB-10 deployed drill (Phase-4 §8)

The full ACP job loop on the **as-deployed** stack: requester originates an
owner-seeded job → provider reasons(0G)+delivers(0G Storage) → evaluator skeptic
verdict → deterministic acceptance floor → **owner approval from a phone
notification** → **governed ERC-20 settlement** of the job fee → multi-party PoA.

Script: `backend/scripts/deployed-job-drill.mjs`
Evidence output: `docs/evidence/phase4-d-job-10.json` (untruncated hashes).

## Prerequisites (external — must be true before running)

1. **Render backend redeployed on the Phase-4 branch** (job runtime + token
   settlement + the 3 ACP roles + `PUT /api/job-specs`, `GET /api/jobs`).
2. **Render env `LEASH_FACTORY_ADDR` = the v3 token-capable factory**
   `0xcD7818673238E2703585CF96658FeBf1a10f8105` (see `docs/DEPLOYMENTS.md`).
   Without this, created accounts are native-only and the ERC-20 settle can't run.
3. **Telegram bot configured on Render** (`TELEGRAM_*` env) — the approval card
   pushes to the phone.
4. Local `backend/.env` has `OPS_PRIVATE_KEY` (funds gas) + `ZERO_G_RPC` + Privy —
   already present. The script mints TestUSD to the requester account itself.

## Run

```bash
cd backend
node scripts/deployed-job-drill.mjs
# optional overrides:
#   DEPLOYED_API=https://leash-0g-backend.onrender.com
#   SETTLEMENT_TOKEN=0xbeeA96c7614ebc46760B442068E359e51e7c4e52   (v3 TestUSD)
```

## What you do on the phone

1. Tap the fresh **Telegram START link** the script prints (links the throwaway owner).
2. Wait for the **LEASH settlement card** (job fee 2 TestUSD → throwaway recipient).
   It arrives only after the floor + evaluator verdict both pass (the layered gate).
3. Tap **✅ APPROVE**. The script detects `status:'settled'`, verifies the ERC-20
   transfer on-chain + the recipient balance, captures the PoA, tears down, and
   writes the evidence JSON.

## Pass criteria

- Job reaches `awaiting_approval` (proves floor + verdict passed, D-JOB-3).
- After the phone APPROVE: job `settled`, `settlementTx` succeeds on-chain,
  recipient received exactly the server-state fee (F4), multi-party PoA present
  (requester/provider/evaluator sigs + settlementTx) and on the owner/audit stream.
- The settle trace is labelled `category:'jobFee'` (§8) — appears as a distinct
  "job fee settled" line in the digest, never rolled into native 0G spend.

## Notes / honest caveats

- The script never approves — the phone does (D-JOB-10 is a real human-in-the-loop
  approval). It only polls job status.
- Free-tier Render sleeps; the script waits up to 3 min for wake at `/healthz`.
- Throwaway owner/recipient keys are generated per run (no state reuse).
