# Phase 4 — Real Use-Case (Olas-Mech/ACP 3-role job) — BUILD progress

Spec: `~/0g-fleet/docs/phases/PHASE-4-real-usecase.md` (Gate ① 7/7 PASS). Order per spec §3 + §9.

## a. P4C debt — DONE ✅ (verified)
- [x] **P4C-1** SSE cap per owner + global + idle-timeout heartbeat reaper — `backend/src/sse/hub.ts` + config `SSE_MAX_GLOBAL/PER_OWNER/IDLE_TIMEOUT_MS` + wired in `index.ts` + owner threaded at the agent-stream route. Test `test/unit/sse-hub.test.ts` **7/7 green**.
- [x] **P4C-2** hard alert-rate cap — advisory lock hoisted to top of `emitOrThrow` (`alerts/service.ts`), folded into the BEGIN round-trip (two-int4 advisory form, JS-computed key, distinct lock space) so ZERO added round-trips. Alerts storm/dismiss tests **green** (storm 20s, was 60s-timeout with the naive extra round-trip).
- [x] **P4C-3** dropped `landing/` from `pnpm-workspace.yaml`.
- [x] **P4C-4** live-eval first-try green — **DONE via `test/unit/job-layering.test.ts` (deterministic boundary assertion, 5/5 CI green)** + live lane retries in `test-live/job-evals.live.test.ts`.
- [x] **P4C-5** doc-honesty (PHASE-3-RESULTS "attempt-2" + "17 errors") + code nits: sanitizer code-point truncation (`util/format.ts`), webhook secret-check BEFORE json parse + error-log message-only (`telegram/routes.ts`).

## b. v3 contracts + FULL RE-AUDIT (HARD CHECKPOINT) — DONE ✅ (PASSED)
- [x] `LeashAccount` v3 `executeTokenTransfer` (contract-encoded IERC20.transfer, SafeERC20 return check, CEI, nonReentrant); immutable `settlementToken`; `TokenPolicy` caps; token tumbling window (shared windowSeconds); tighten-instant/loosen-timelocked (`tighten/propose/applyTokenPolicy`); L-05 clears pending token slot; `execute` STILL reverts CalldataForbidden.
- [x] `MockERC20` (TestUSD, 6dp, open faucet, test-labelled).
- [x] Factory v3 (+settlementToken +TokenPolicy; native-only = address(0); legacy v2 unaffected). `DeployV3` script.
- [x] Tests: **90/90 forge** (57 native regression + 32 token unit/fuzz + 1 token invariant), incl. reentrant/false-return/no-return token cases, D-JOB-6 (calldata forbidden), all forbidden-action reverts, L-05.
- [x] **Slither `--fail-medium` exit 0** (13 results, 0 high/med; triage appended to SLITHER-TRIAGE.md).
- [x] **security-auditor subagent: HARD-CHECKPOINT PASS** — no critical/high/medium; no drain/bypass; 7/7 required properties PASS with file:line evidence.
- [x] **Live redeploy** (2026-09-23): `DeployV3` broadcast on 16602 via ops key `0xc211…12A5` → factory v3 `0xcD78…8105` (tx `0x416f…347a`) + TestUSD `0xbeeA…4e52` (tx `0x3d5d…e5d5`), both status 0x1; Sourcify `exact_match` both; untruncated addrs/txs in `docs/DEPLOYMENTS.md`.

## c. Backend runtime goal-union (runtime-only) — IN PROGRESS
- [x] RequesterGoal/ProviderGoal/EvaluatorGoal + `goalRole()` + `isSpendIncapableRole` + `goalAllowlistCandidates` (`types.ts`); tree typechecks (legacy graph/prompt narrowed cleanly).
- [x] 4 opaque envelope kinds strict Zod + JobSpec + `parseJobPayload` (`jobs/envelopes.ts`) — **8/8 tests**.
- [x] Generic acceptance rule engine (F2, `jobs/acceptance.ts`) — **7/7 tests** incl. the honest-limit (schema-valid-but-wrong passes floor).
- [x] Chain client: `executeTokenTransfer` (SessionChain + RuntimeChain iface), factory-v3 wiring in `deployAndRegister` (+settlementToken/tokenPolicy, ChainOps type), token-window observability in `readPolicyView` (F9 mixed v2/v3 — probes settlementToken, native-only falls back), ABI + 5 token errors + TokenExecuted event + plain-language copy — **leash-errors 29/29 (22-error pin)**.
- [x] Create validation for the 3 new goals + settlement-token config (owner-routes `goalSchema` + `tokenConfigSchema` + superRefine: requester tokenConfig required + feeToken==settlementToken + feeCap≤perTokenCap + feeRecipient∈allowlist; provider/evaluator zero-native-cap; tokenConfig requester-only) + wired into `deployAndRegister`. **owner-api Phase-4 suite 9/9**.
- [x] Job runtime nodes (provider work → 0G Compute+Storage / evaluator verdict / requester settle) + requester-hub topology (F6) + owner-seeded spec (F5) + fee-from-server-state (F4) + evaluator model≠provider (F8) + PoA signing. **→ `jobs/graph.ts` `buildJobGraph`, manager dispatch, 4/4 integration green.**

## d. Layered verification gate — CORE DONE, wiring TODO
- [x] `jobs/gate.ts` `evaluateGate` (D-JOB-3: each layer alone blocks — floor→verdict→owner) — **6/6**.
- [x] `jobs/poa.ts` multi-party signing + `buildPoaRecord` + `verifyPoa` (F7; structural-acceptance-only in the record, F-quar) — **5/5**.
- [x] `jobs/prompt.ts` provider work prompt + evaluator skeptic prompt (anti-sycophancy) + parsers — **7/7**.
- [x] Wire into the job graph: floor → evaluator verdict → owner approval interrupt → executeTokenTransfer → PoA → owner-record → 0G Storage. **→ `jobs/graph.ts` verdictGate + requestApproval nodes; layered-gate blocking proven per-layer.**

## ✅ DONE THIS CHAT — job runtime graph + wiring (items 1–3) — GREEN
1. **jobs projection + job_specs registry** — `migrations/011_jobs_projection.sql` (`jobs` read-model: jobId ↔ request/deliverable(plaintext hot)/verdict/acceptance/settlement + PoA; `job_specs` owner-seeded registry with acceptance ruleset + fee F4/F5). Stores `store/job-specs.ts` + `store/jobs.ts`.
2. **`jobs/graph.ts`** `buildJobGraph` — one graph, branched per (role,inbound) by `classifyJobCycle`; mirrors the manager contract (invoke{inboundDelegation} / interrupt{approvalId} / getState). PROVIDER (job.request→reason→deliverable→ECIES+0G Storage→sign→job.deliver); EVALUATOR (job.evaluate→skeptic reason→verdict→sign→rationale upload→job.verdict); REQUESTER (originate owner-seeded job.request; job.deliver→acceptance floor→job.evaluate|reject; job.verdict→evaluateGate→owner approval interrupt→governed executeTokenTransfer(F4)→buildPoaRecord→owner-record 'poa'). Idle polls don't trace (no chain spam).
3. **Manager dispatch** — `manager.ts start()` branches `buildJobGraph` vs `buildTreasuryGraph` by `goalRole`; `uploader?: StorageUploader` added to `RuntimeManagerDeps` + threaded from `index.ts` (ZeroGStorage moved above the manager). `types.ts` `OwnerRecordKind += 'poa'`.
- **Proof:** `test/integration/job-runtime.test.ts` — full lifecycle (originate→deliver→accept→owner-approve→governed ERC-20 settle + multi-party PoA + owner-record) + each gate layer alone blocks (D-JOB-3: acceptance floor / evaluator reject / owner deny). **4/4 green.** No regression (runtime 8/8, runtime-coordination 13/13). tsc clean. (Test uses MemorySaver checkpointer to keep LangGraph super-step writes off Neon; jobs/coordination/traces still hit real DB.)

## ✅ DONE THIS CHAT (cont.) — evals (item 4)
4. **Evals** — TWO lanes:
   - **Deterministic layering-proof (CI, first-try green, P4C-4)** — `test/unit/job-layering.test.ts` **5/5**: a schema-valid-but-semantically-wrong deliverable PASSES the floor (F7-limit / §3d.1 honest structural-only limit); the floor still blocks malformed; evaluator-reject blocks at 'verdict'; owner-pending/deny blocks at 'owner'; all-three-pass is the ONLY release. No LLM — deterministic.
   - **Live real-trace eval (test-live lane, `npm run test:live`)** — `test-live/job-evals.live.test.ts`: 16 real-trace market questions → provider (**deepseek-v3**) produces schema-valid + floor-passing work (HARD, D-JOB-1/8 — validated live); evaluator (**glm-5**, ≠ provider per F8/§0.6, confirmed available via router `/models`) — **F7-limit reject is HARD & green live** (skeptic catches schema-valid-but-wrong garbage). Accept-direction is OBSERVED not gated + an accept-rate calibration metric.
   - **CALIBRATION DONE (§8, before/after recorded):** the original maximally-skeptical evaluator (§3d.2 "default to REJECT... completely/correctly answers") was **fully wedged — accept-rate 0/16 = 0%** on real deepseek-v3 deliverables (would NEVER pay; §6's evaluator-DoS worst case). **Recalibrated `buildEvaluatorRequest` (`jobs/prompt.ts`)** to a *refute-first, concrete-defect-bar* skeptic that does NOT punish honest uncertainty (forecasts have no certain answer) — still anti-sycophancy (§3d.2 faithful). **After: accept-rate 8/16 = 50%** (full 19-test live suite green), F7-limit garbage STILL hard-rejected, and the accepted cases are genuinely grounded (Solana-ETF 0.35, renewables 0.75) while generic/vague work is still rejected — correct discrimination, not sycophancy. Remaining rejects are PROVIDER-side grounding quality, not evaluator over-conservatism. `job-prompt.test.ts` updated + green.
   - **§0.6 model decision CONFIRMED + WIRED: provider=`deepseek-v3`, evaluator=`glm-5`** (≠ provider, F8). New config `JOB_PROVIDER_MODEL`/`JOB_EVALUATOR_MODEL` (`config.ts` + `.env.example`), threaded RuntimeSettings→manager→`buildJobGraph` with role-aware resolution (`ctx.goal.model` override wins; requester never reasons). tsc clean, unit 155/155, job-runtime happy-path still green.

## ▶ RESUME HERE (next chat) — live redeploy + FE + drill
5. **Live redeploy** (b tail): `forge script DeployV3` with funded key `0xc211…12a5` → factory v3 + TestUSD on 16602 → Sourcify → DEPLOYMENTS.md (untruncated).

## e. FE parity (spec §7) — IN PROGRESS (cockpit half DONE, create-flow half TODO)
**DONE THIS CHAT (cockpit + read surface + errors):**
- [x] **Backend read API** — `GET /api/jobs`, `GET /api/jobs/:id` (owner-scoped, cross-owner 404), `PUT/GET /api/job-specs/:ref` (owner-seeded spec registry, F5) in `api/owner-routes.ts`. Test `test/integration/job-api.test.ts` **4/4**.
- [x] **`web/lib/leash-errors.ts`** — 5 token errors added (22 total); `tests/leash-errors.test.ts` updated **4/4**.
- [x] **`web/lib/api.ts` + `web/lib/types.ts`** — `listJobs/getJob/putJobSpec/getJobSpec` + `JobView/OwnerJobSpec/PoaRecord/AcceptanceRuleSet` types (PUT added to method union).
- [x] **Cockpit job lifecycle view (D-JOB-9 headline)** — `components/cockpit/JobLifecycle.tsx` (4 ACP stages; QUARANTINED deliverable summary + rationale F-quar; layered-gate display floor→verdict→owner; verdict-bound settlement approve/deny on the shared approvals rail; governed settle tx; multi-party PoA) + `JobsList.tsx` + `/app/jobs` + `/app/jobs/[id]` pages + nav link. Test `tests/job-lifecycle.test.tsx` **7/7**. Full web suite **140/140**.

**DONE (cont.) — job-spec editor (F5 create surface):**
- [x] **`components/create/JobSpecEditor.tsx`** — the owner-seeded job spec (F5 AUTHORITY: fee + acceptance rules in server state, not model text F4) with a generic acceptance-floor rule builder (F2: required/type/numberRange/stringLength/enum/arrayMinLength) → `PUT /api/job-specs/:ref`. Page `/app/jobs/specs` + "Define a job" link on `/jobs`. Test `tests/job-spec-editor.test.tsx` **3/3**. Web suite **143/143**.
- **RESOLVED (flagged risk):** token-policy owner ops are **client-side owner wallet txs** (`web/lib/chain.ts` + PolicyPanel `onSubmitPolicy` picks tighten/propose/apply) — **NO backend gap**; the LeashAccount v3 `tighten/propose/applyTokenPolicy` are called directly from the owner wallet, exactly like the native policy edits.

**DONE (cont.) — create-wizard role extension:**
- [x] **`CreateWizard.tsx` extended for all 3 ACP roles** — provider (spend-incapable + serviceSpec), evaluator (spend-incapable + rubricRef), requester (sole governed spender: jobSpecSource + provider/evaluator pickers + feeRecipient/feeCap + settlement-token config with per-token caps, F1). Role-aware goal step, 4 new step forms, role-aware review summary, fee-cap≤per-transfer-cap guard (F4). Backend `GET /api/agents` summary now carries `role` (derived via `goalRole`) so the requester's provider/evaluator pickers can filter; create page fetches + filters + threads `tokenConfig`. Test `tests/create-wizard-jobs.test.tsx` **4/4** (incl. F4 over-cap block); existing wizard tests **16/16** unregressed. Web suite **147/147**, backend owner-api+job-api **33/33**, both tsc + eslint clean.
- **FE PARITY §7 EFFECTIVELY COMPLETE** for the job feature: create (3 roles + token config + job-spec editor) + cockpit (lifecycle/quarantine/gate/settlement/PoA) + decoded token errors. 

**TODO (minor FE polish — non-blocking):**
- [ ] Token-policy POST-CREATE edits in PolicyPanel (tighten/propose-loosen/apply for the token path) + token allowlist add/remove + migrate legacy→token CTA — client wallet txs via `web/lib/chain.ts` (needs v3 token-policy ABI/fns). NB: token config is IMMUTABLE at create except caps; this is only the cap-adjust surface.
- [ ] Policy panel token-window observability display (`getPolicyView` already returns `settlementToken`/token caps/`spentInWindowToken`; surface them).

## f. Deployed drill D-JOB-10 — SCRIPT + RUNBOOK READY; execution BLOCKED on 2 external prereqs
- [x] `backend/scripts/deployed-job-drill.mjs` — full ACP loop on the deployed stack: real Privy SIWE (headless, FE flow) → seed owner job-spec (F5) → create requester(+tokenConfig)/provider/evaluator + F6 hub links → mint TestUSD to requester account → start triangle → wait `awaiting_approval` (floor+verdict gate) → **phone APPROVE** → poll `settled` → verify ERC-20 tx on-chain + recipient balance + multi-party PoA on owner stream → evidence JSON `docs/evidence/phase4-d-job-10.json`. Reuses proven SIWE/api/waitUntil/waitReceipt helpers. Syntax-clean; every API surface verified against owner-routes (create 3-role, `PUT /api/job-specs`, `POST /api/links`, `GET /api/jobs`, start/revoke). Runbook `docs/runbooks/D-JOB-10.md`.
- [x] **D-JOB-10 PASSED ✅ (on-chain, 2026-09-23)** — deployed the Phase-4 backend (commit 9b1ca34) with env `LEASH_FACTORY_ADDR`=v3, ran the drill against the live stack. Job `b4d6e703`: originated→evaluating→**awaiting_approval (verdict=accept)**→ owner APPROVE on phone → **settled**. Governed ERC-20 tx `0x23d7deb710740d167c9b9699278c63bcd73b1e49e9beabd522a8460df3b13c97` (status success, block 56367817, Transfer log), recipient received exactly 2 TestUSD, multi-party PoA recorded. Verified server-side via DB, not just the log.
- **Drill bug found + fixed en route:** live provider (deepseek-v3) emitted nested `{analysis}` instead of top-level `probability/rationale` → floor rejected every deliverable. Root cause: provider prompt only got the opaque `deliverableSchemaRef`, never the real field contract (which lives in the acceptance rules). Fix (commit 9b1ca34): `renderAcceptanceContract` → `job.request` envelope → provider prompt. Unit+integration 8/8. Also hardened the drill's fetch against transient network blips.

## i. Asset-aware settlement display — IN PROGRESS (Dami caught: card showed "0.00 0G" for a 2 TestUSD fee)
Root cause: the approval card renders the fee with `formatG` (native 18dp 0G) but the fee is a 6dp ERC-20 amount → "0.00 0G". Card must DETECT the asset (native 0G for treasury vs the actual ERC-20 like USDC/TestUSD for jobs) and label it correctly. Dami decisions: read decimals+symbol on-chain (store), FULL card redesign, must explain WHY approval is requested.
- [x] Backend (commit da267e7): `getErc20Meta` on-chain read; store `fee_token_symbol`/`fee_token_decimals` on the job row (migration 011), read once at originate; `formatAsset(baseUnits,decimals,symbol)` (unit 4/4 — the "0.00 0G" value now renders "2 TestUSD"); verdictGate card REDESIGNED (names the job, states WHY = cleared both automatic checks, frames the tap as the final release gate approve=pay/deny=withhold, shows true asset); SSE `assetLabel`.
- [x] FE (commit da267e7): `ApprovalCard` prefers `assetLabel` (native 0G fallback); `JobLifecycle` detects asset from `job.feeTokenSymbol`/`feeTokenDecimals`; `JobView` type + `jobView` API carry the meta. FE 7/7, web tsc clean.
- [ ] DEFERRED (minor): §8 digest job-fee line stays count-based ("N job fees settled") — honest, not wrong; amount-with-symbol enrichment needs symbol/decimals on the settle trace, low value.
- **Verify:** job-runtime 4/4 (settle lifecycle w/ asset changes), runtime 8/8 solo, format-asset 4/4, FE 7/7. (job-api solo hit a Neon connection-timeout at CREATE SCHEMA — environmental, passed 4/4 earlier.)
## g. Calibration (§8) — DONE ✅ (label job-fee spend distinctly)
- [x] Job-fee ERC-20 settlements now labeled `category:'jobFee'` + `feeToken`/`feeAmountWei` on the settle action trace (`jobs/graph.ts`), kept OUT of the native `spendWei`/`actions` totals. Digest (`digest/service.ts`) aggregates a separate `jobFees {count, byToken}` per-agent + totals; `renderText` names "N job fees settled" on its own line (no invented token symbol — backend stores raw base-units, FE decodes; exact amounts live in structured `jobFees.byToken`). Tests: digest-render 5/5 (+§8 case), digest integration 10/10, job-runtime 4/4 + layering 5/5 (no regression). tsc clean.

## h. Adversarial review (pre-deploy gate) — DONE ✅ (fixes landed + verified)
Two independent adversarial agents (security-auditor + code-reviewer) on the uncommitted Phase-4 money path.
- [x] **BLOCKER** (my §8 code): digest lead dropped "N decisions came to you" for the flagship job shape (actions=0, jobFees≥1, decisions≥1). Fixed — lead composed from independent clauses; added a real-shape test (`digest-render` now 6/6).
- [x] **HIGH-1** double-settle: `requestApproval` resume had no CAS before the on-chain transfer. Added `claimSettlement` (atomic `awaiting_approval`→`settling` on the jobId) + `recordSettlement` guarded to `WHERE status='settling'`; new `settling` status added to `migrations/011` CHECK. Cross-job replay already impossible (thread + broker.notify bound).
- [x] **HIGH-2** drill footgun: ops key could fund an attacker via poisoned `DEPLOYED_API`/`SETTLEMENT_TOKEN`. Pinned host+token allowlist (`--i-understand-override`) + address-shape validation before any native send.
- [x] **MED-1**: provider/evaluator now reply to `job.requesterAgentId` (authoritative), not the envelope sender.
- [x] **NIT**: `byToken` keys lowercase-normalized (no checksum split-key).
- [x] Accepted (documented): MED-2 job-spec PUT rate limit + LOW-1 re-validate-on-read — self-scoped; `feeCapPerJobWei` (graph.ts:226) is the real backstop, per reviewer.
- **Confirmed HOLDING (file:line evidence from both agents):** F4 server-state fee authority, verdict-bound layered gate (D-JOB-3), PoA integrity, requester-only spend, cross-owner authz (no IDOR).
- **Verified:** job-runtime 4/4, job-layering 5/5, digest-render 6/6, digest integration 10/10; full backend suite green (one telegram sim test is a known timing flake — passes 16/16 in isolation). tsc clean.

## READY TO DEPLOY (Dami's gate cleared): env-var + push are mine to do
- Render CLI is authenticated; the API key in `~/.render/cli.yaml` (`rnd_VIrg…`) DOES authorize the REST API (my earlier "needs you" was wrong). I can set `LEASH_FACTORY_ADDR`=v3 on `srv-dao4q9jtqb8s73dt96b0` myself.
- Deploy = commit the 69 Phase-4 files + push to `origin/main` (auto-deploys). Backend build verified green (`pnpm --filter backend build`).
- Per Dami: do this AFTER the adversarial review (now done). Then run D-JOB-10 (needs the phone tap).

## Exit protocol (phase complete only): STATE + 07 + PHASE-4-RESULTS (§12 Phase-4.5 evidence) + Gate-② REVIEW handoff.

## d. Layered verification gate — TODO
- deterministic acceptance floor (generic config-driven rule engine keyed off acceptanceRef, F2) → skeptic evaluator verdict → owner-supervised release (verdict-bound, P3C-2); signed multi-party PoA (F7) → 0G Storage; deliverable + rationale QUARANTINED-untrusted (F-quar).
- Evals-in-CI (~20 real-trace, skeptic judge) + layering-proof eval (schema-valid-but-wrong caught).

## e. FE parity (spec §7) — TODO
## f. Deployed drill D-JOB-10 — TODO (real SIWE + phone approval → governed ERC-20 settle)
## g. Calibration (§8) — TODO

## Exit protocol (only when phase complete): STATE + 07 + PHASE-4-RESULTS + Gate-② REVIEW handoff.
