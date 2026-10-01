# STAGE-E SE-10 — GATE ② BUILD REVIEW (master, independent verify)

**Slice:** SE-10 — Ethereum Sepolia PROMOTION to a full governed home chain + generic `EXTRA_CHAINS` chain-table (done-criterion **E-11**).
**Tier:** TIER-3 LIGHT grouped master Gate-② (07 §152) — CONFIG / thin-repeat slice, **NO new structured decoder, NO contract change** (Solidity source BYTE-IDENTICAL to SE-9).
**Branch:** `stage-d-governed-calldata`, uncommitted working tree (merge deferred to Stage-E close).
**Reviewed:** code DIFF + RESULTS + on-chain artifacts — not transcript. Independent re-derivation via `code-reviewer` + `security-auditor` subagents, suites run locally, on-chain txs verified via `cast`.
**Date:** 2026-10-01.

---

## Independent verification evidence

| Surface | Expected | Observed | Result |
|---|---|---|---|
| `contracts` forge test | 323 (byte-identical to SE-9) | **323 passed, 0 failed** | ✅ |
| `backend` unit + redteam | ~431 | **432 passed** (+1 = override-test NIT fix added in-phase; benign) | ✅ |
| `backend` tsc --noEmit | clean | **clean (no output, exit 0)** | ✅ |
| `backend` eslint | clean | **clean (no output, exit 0)** | ✅ |
| `web` tsc + vitest | 223 | **223 passed (40 files)** | ✅ |
| Factory codehash on Eth Sepolia (11155111) | `0x4771f057…f325` | **`0x4771f057…` matches**, codesize 19218 | ✅ |
| No SE-10 edit in contract source | 0 markers | **0 `SE-10`/`E-11` markers; diff = SE-9 delta only** | ✅ |
| Latest drill happy `transfer(self)` tx | status 1 | tx `0xc1c826fa…042a` → **status 1 (success)** | ✅ |
| Latest drill redirect tx | status 0 | tx `0x4fc06df3…0866` → **status 0 (failed)** | ✅ |
| Live drill runs | 2× GREEN 12/12 | **4× GREEN 12/12** (09:21–09:35Z) | ✅ |
| Default-deny negative | reverts | chain 999999 → `UnregisteredChainError`; gate `destination_unregistered` / `destination_chainid_mismatch` | ✅ |

**Subagent verdicts (independent re-derivation):**
- `code-reviewer`: **APPROVE-WITH-NITS** — 0 BLOCKER, 0 WARNING, 3 NITs (cosmetic).
- `security-auditor`: **PASS** — 0 BLOCKER/HIGH/MEDIUM, 2 LOW (cosmetic); all 5 critical threats SAFE.

---

## Mandatory 8-item compliance checklist

**1. Done-criterion met (E-11)** — ✅ **PASS.** CREATE2 same-address mint on Eth Sepolia (account `0xDFeBa9…730B` has code); full home-on-Eth-Sepolia sense→decide→gate→act loop runs live (RUN_DEPLOYED_DRILL integration test); governed happy `transfer(self)` LANDS on-chain (tx `0xc1c826fa…042a` status 1 vs real WETH9 `0x7b79…e7f9`); malicious matrix REVERTS selector-anchored + real redirect tx `0x4fc06df3…0866` status 0. 4× GREEN 12/12 in `docs/evidence/stage-e-se10-promotion-drill.json`.

**2. Enforcement (00 §6c, 04 §2b)** — ✅ **PASS.** On-chain hard boundary unchanged (forge 323/323, codehash `0x4771f057…` identical to SE-9 deployed wall). Per-call cap binds (`over-cap REVERTS OverPerCallCap`), window cap debited (`_debitCallWindow`), recipient hard-pinned self (`RecipientNotSelf`). New chains inherit the identical wall (same factory CREATE2 address). Default-deny for unregistered chains (`UnregisteredChainError`) — agent cannot reach an un-onboarded chain.

**3. Privacy / self-sovereignty (00 §6b)** — ✅ **PASS.** No change to the signing locus: SE-10 is config only. Guardian key is never used for CREATE2 prediction (registry.ts:120-123 doctrine intact). No owner key enters agent runtime; the slice adds no key-handling path.

**4. Two-tier proof / audit (00 §7)** — ✅ **PASS.** Trace carries `chain_id=[11155111]` for the home-on-Eth-Sepolia loop; tamper-evident trace path unchanged from SE-9. Drill evidence is a reproducible, timestamped, per-check JSON artifact (`stage-e-se10-promotion-drill.json`).

**5. Quality bar (02-BUILD-METHODOLOGY §9/§10)** — ✅ **PASS.** Happy + edge + failure/adversarial coverage: `se10-chain-config.test.ts` asserts destination-only-when-unset (`canonical`/`protocolAllowlist` `toBeUndefined` pre-promotion), mainnet-id-in-EXTRA_CHAINS refusal, duplicate-chain guard, fail-loud parse. CI-reproducible (backend 432 / web 223 / forge 323, tsc+eslint clean) — not a witnessed-only run. No stubs/hollow asserts (subagent-confirmed). TS strict.

**6. Decision governance (07)** — ✅ **PASS.** No locked decision violated. New decision **SD-E13** recorded in `07` + `LIMITATIONS.md` (the SE-9 `outboundTransfer` budget-key carry, corrected documentarily). The DOC-not-source fix is sound and verified: Solidity metadata hash covers comments → a comment edit changes the codehash → would break the SE-9 cross-chain-identical deployment; recorded in docs auditors read instead. LOCKED review cadence (§152) honoured (TIER-3 LIGHT).

**7. Scope discipline** — ✅ **PASS.** Built only the SE-10 scope: `config.ts` (parser + promotion block + append), 2 new tests, 1 drill script, LIMITATIONS.md, evidence JSON. **Zero** contract edits (0 `SE-10` markers in `contracts/src`; diff is purely the approved SE-9 delta). Honest gap (SD-E13) disclosed accurately and proven NON-fund-loss (amount==0 moves nothing; recipient self-pinned; caps bind for amount>0). No overclaims found. FE-parity: no new owner op → the SE-7 per-chain Networks panel already surfaces promoted/onboarded chains; no new surface owed.

**8. On-chain artifacts authentic** — ✅ **PASS.** Independently re-verified via `cast` against `ETHEREUM_SEPOLIA_RPC`: factory `0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f` has code (codesize 19218), codehash `0x4771f057…`; happy tx status 1; redirect tx status 0. All match the evidence file.

---

## Carries (non-blocking — fold forward per Two-Tier verdict)

All cosmetic; none structural, none fund-affecting. Carried to the Stage-E close / merge pass:

1. **[NIT]** `registryAddr` and the Eth-Sepolia promotion `canonical`/`SEPOLIA_CAP_*` addresses are stored un-lowercased, unlike `parseAddressList`/`parseExtraChains`. Harmless today (only consumer `owner-routes.ts` lowercases both sides); inconsistent with the slice's own normalization doctrine. One-line fix: `.toLowerCase()` the inserts.
2. **[NIT]** The `EXTRA_CHAINS` `> 32` size-bound has no dedicated test; a 33-entry array asserting `/too many/` would lock the bound.
3. **[NIT]** `ARB_PROTOCOL_ALLOWLIST` hand-rolls the same split/trim/lowercase/throw logic the new `parseAddressList` helper provides two lines away — reuse for a single source of truth.

---

## VERDICT: ✅ **APPROVE** (PASS-WITH-CARRIES)

All 8 checklist items PASS on independent evidence. Both audit subagents independently clear the slice (0 BLOCKER/WARNING/HIGH/MEDIUM). E-11 is genuinely met, not overclaimed — on-chain txs re-verified. The mainnet-smuggling vector is provably closed (`assertTestnetOnly` runs over the full `buildChainConfigs` output, including `EXTRA_CHAINS`, in the `ChainRegistry` constructor before indexing). SD-E13 is a genuine non-fund-loss and the doc-not-source correction is correct. Three cosmetic NITs carry forward to the merge pass.

**Stage-E chain fan-out is CLOSED.** Next step = **Stage-E DEPLOY REVIEW + merge-to-main** (deploy the SE-9 factory to 0G + Base at the same CREATE2 address, flip `LEASH_FACTORY_V4_ADDR` in Render, merge `stage-d-governed-calldata` → main). Dami is the gate.
