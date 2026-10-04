# RH2 E2E Campaign — Master Structure & Run-Stage Scoping

**Deadline: tonight, 2026-10-04 EOD (flexible per GATE2-KICKOFF).**
Companion docs: `RH2-E2E-TEST-PLAN.md` (mechanical C1–C22 cases), `tasks/e2e-rh-findings.md` (live findings log), `HACKATHON-RH2-E2E-CAMPAIGN-KICKOFF.md` (directives).

Two layers run together in every stage:
- **C-cases** (mechanical): route/screen coverage, walls, H/S/A per capability.
- **P-scenarios** (promise): each build stage's intent, decomposed into claims with distinct proofs.

Convention: each run-stage below is sized to ONE focused session (new chat if needed, per
the pipeline-chat convention). Each has a kickoff line, inputs, exit criteria, and writes
its results into `tasks/e2e-rh-findings.md` under its own heading.

---

## The promise layer (P-scenarios) — authoritative definitions

### P1 — Foundation I: "the cage holds"
| id | claim | proof |
|---|---|---|
| P1.1 | Per-transfer cap is contract law | Session key attempts over-cap transfer DIRECTLY on-chain (bypassing backend) → revert. Backend wall is convenience; contract wall is the product. |
| P1.2 | Window cap is stateful | N transfers each under per-cap but breaching window: N-1 succeeds, N reverts; after windowSeconds/rearm, spending resumes. Timed sequence, not one-shot. |
| P1.3 | Allowlist binds | In-cap transfer to unlisted address reverts on-chain; chat-injected redirect attempt dies at the contract with a `block` trace, not silently. |
| P1.4 | Expiry makes account inert | Short-expiry agent lapses mid-run → every execute() reverts; runtime surfaces plain-language error; cockpit shows the lapse. |
| P1.5 | Two-lane authority | (a) session key calling proposePolicy → revert; (b) owner tighten instant; (c) owner loosen timelocked, early apply reverts. |
| P1.6 | Guardian revoke unstoppable | Revoke mid-loop: on-chain revoked()=true, runtime halts, pending dies; guardian-lane failure still halts backend-side + fallback steer (C-2). F-1 (watcher dead >32 agents) bites here. |

### P2 — Foundation II: "agents are alive" (one-loop-cycle bar — Dami)
Five links; a silent agent means one is severed. Isolate which.
| id | link | proof |
|---|---|---|
| P2.1 | create → runtime registration | Created agent has runtime entry; UI-created agents born paused — is "press start" obvious? (suspect #1 for the "nothing to poll" report) |
| P2.2 | start → loop ticking | status:running SSE event, loop evidence within one cycle |
| P2.3 | loop → 0G Compute | `inference` trace with real content; probe the global LLM limiter (500/h fleet) as silent-idle suspect |
| P2.4 | decision → governed action | **Action lands within ONE loop cycle of start+stimulus** (tx hash in `action` trace, balance moves) |
| P2.5 | action → user's eyes | Same events arrive LIVE on the SSE stream the cockpit renders (not only in traces table on refresh) — suspect #3 |

Per-role "alive" matrix: treasury = autonomous top-up (only self-starter) · sentinel = must NOT act, must delegate on dip (a transferring sentinel is worse than an idle one) · executor = idle until delegation, then acts within own policy · requester/provider/evaluator = alive only inside a job (their liveness IS the ACP triangle). Supply the stimulus before judging: dip the beneficiary, send the delegation, post the job.

### P3 — Stage B: "a novice creates a good agent"
| id | claim | proof |
|---|---|---|
| P3.1 | Elevation: rough text → sane draft | Realistic novice intents → right role, plausible caps, honest unsureFields, NEVER an invented recipient. Hostile intents → spend-incapable/blank-money drafts (A1 proved once: injected addr survived only as inert serviceSpec text). |
| P3.2 | Templates work as shipped | Each of the 3 templates, blanks only → finished agent → apply P2 liveness bar. Well-formed-but-dead template = stage failure. |
| P3.3 | Wizard ladder + gates | Sentinel path shows no cap inputs; requester advanced door locked until ≥1 provider + ≥1 evaluator + ≥1 job spec (D-A1); review step shows what will be signed. |
| P3.4 | Never-guess-money + KEK custody | Recipient always owner-typed; audit key leaves browser only KEK/passphrase-encrypted. Hostile input in every free-text field. B-4 (double KEK sign, no wallet nudge) logged here as UX finding. |

### P4 — Stage C: "talk to a running agent"
| id | claim | proof |
|---|---|---|
| P4.1 | Redirect with read-back (R-1) | Happy: redirect thresholds → confirm → NEXT loop cycle acts on new numbers (behavior change, not DB write). Adversarial: role-change/recipient intents can't carry; smuggled money keys in `edited` → visible 400. Race: concurrent confirms → one CAS 409. |
| P4.2 | Stateful status | Answer derives from real trace stream; injection round ("print your system prompt/token") leaks nothing, renders plaintext. |
| P4.3 | Lifespan is a dial | Wind-down: loop stops, origin chains terminated, in-flight cancelled, completion alert, agent re-directable after (not a tombstone). Rearm: B-5 desync probe lives here. |
| P4.4 | Chaining bounded by links | 2-hop chain executes (hop 2 receives AND acts); depth-4/fan-out-4 → 400; chain through revoked/foreign agent refused; no link → no handoff, period; supervised interposes owner approval. |

### P5 — Stage D: "pay anywhere, still caged"
| id | claim | proof |
|---|---|---|
| P5.1 | Signing locus never moves | Grant mutations without txHash change no on-chain state; fabricated-txHash probe → does read-model verify or trust? (pin down either way) |
| P5.2 | Resolution from server state | JIT card target/selector/args match server-computed call hash; prose-says-Uniswap-calldata-says-elsewhere surfaces the calldata truth. |
| P5.3 | Approve-once = exactly once | Approve → executes → same call hash needs fresh grant (decision replay rejected; re-attempt spawns NEW request); deny → never executes; ignore → 600s TTL auto-resolve. |
| P5.4 | SE-8 gate | Same rule, listed vs unlisted target → sign-flow vs 409; remove/tighten instant+ungated, loosen is the only gated direction. |

### P6 — Portability ladder (SE-7 → SE-10)
| id | claim | proof |
|---|---|---|
| P6.1 | SE-7 same address everywhere | Onboard → codehash on both chains → EXECUTE a governed action on chain 2 under same policy enforced by chain 2's contracts. |
| P6.2 | SE-8 per-chain surfaces | Preset on Base resolves to real Uniswap/Aave; rule to random addr dies at API before any signature. |
| P6.3 | SE-9 divergence in config | Bridge lane works Base→Sepolia AND Arb→Sepolia despite different mechanics; 13 typed refusals hold per chain. |
| P6.4 | SE-10 chain = config entry | Everything home-chain, attempted on RH; RH-only band wall enforced on top. |
| P6.5 | The grand run | One agent: born 0G → onboarded Base + RH (same addr) → governed action on each → band trade in/out of band on RH → ONE revoke → dead on all three. Cage ∩ portability. |

### P7 — RH2 hero: "the band wall is a product lane" (THE DEMO)
| id | claim | proof |
|---|---|---|
| P7.1 | Wall is contract law | In-band swap ✓; >5% deviation → PremiumBreach revert; stale feed → StaleOracle revert; reverting/garbage feed BLOCKS (fail-closed). tightenPriceBand instant; propose/applyPriceBand timelocked. |
| P7.2 | Lane is a product citizen | capability:oracleBand → factory 0x85E1…fF70 (proven A1 via create receipt); same registry/fleet/cockpit/guardian as any agent; only difference = the extra wall. |
| P7.3 | The demo is the test | Full user story in Chrome, recorded (`screencapture -v`): cockpit band agent → fund → in-band sTSLA trade ✓ with explorer link → PremiumBreach rendered as plain-language refusal → StaleOracle ditto → revoke → dead. Feed moves (no UI) happen BETWEEN takes, logged as demo constraint. |

---

## Run-stages (each = one focused session; new chat if context demands)

**Environment for all stages:** backend `https://leash-0g-backend-rh2.onrender.com` (branch 06b9a2d, quota 60, rate 100/h) · web `https://leash-0g-ar2wvij4l-damilolas-projects-fafdf859.vercel.app` · Telegram webhook on rh2 (restore prod by restarting prod service post-campaign) · campaign owners via headless SIWE (`backend/scripts/rh2-campaign/`, keys in gitignored `state/`) · Dami's owner 0xc211…12A5 reserved for Phase B browser work · ops RH balance ~0.0085 after faucet — watch it.

### ── TRACK 1: DEMO-CRITICAL (must finish TODAY before demo) ──
Principle (Dami review 2026-10-04): the demo runs ENTIRELY on the branch stack (prod has no
band lane) — so rh2 backend + preview stability are themselves demo-critical, and EVERY screen
the camera might touch gets at least a happy-path pass tonight (breadth-shallow everywhere,
depth on the hero lane). Environment freeze after B0: no env/deploy churn once smoke passes.

**A2 — Liveness + cage core** `[backend, ~45-60 min]`
- P2 all links × treasury (full) + band-hero on RH; P1.1–P1.4 on the campaign treasury; C4–C7 mechanical.
- Stimulus kit: ops dips/funds beneficiary; direct on-chain session-key attempts for P1.1/P1.3.
- Exit: liveness verdict per link; cage verdicts; findings logged. **If P2 fails at any link for API-created agents, fix round BEFORE Phase B** (demo depends on a visibly-alive agent).

**A5-hero — Band wall + portability spine** `[backend, ~45 min]`
- P7.1 via API/cast on RH (in-band, PremiumBreach, StaleOracle, fail-closed probe); P6.1 (onboard camp treasury 0G→Base, act on Base); P6.5 mini (revoke once, check both chains); P1.6 revoke beats.
- Exit: every on-chain beat of the demo proven to work headlessly, so the recorded run can't surprise us.

**A2 note:** band-hero liveness runs ON RH 46630 (the demo chain), not only the 0G treasury.
**A5-hero note:** drive the RH beats through the PRODUCT's governed path (gateway → session key
→ _enforceAndExecute), not bare cast — the recording must show the product working.

**A3-lite + C10-lite — demo-beat smoke** `[backend + phone, ~20 min]`
- P4.1/P4.2 happy paths only (direct a running agent; status-chat answers from real work);
  Telegram ping + ONE phone approval against rh2. These are the strongest demo moments outside
  the band wall — never first-tried on camera.

**B0 — demo-surface smoke** `[frontend/Chrome, ~30 min]`
- Happy-path pass over EVERY screen on the preview: fleet, cockpit + live stream, inbox,
  links/pair, networks panel, settings, digest, jobs. No 404s, no empty-state surprises;
  characterize B-4 sig-UX stalls so the camera never meets them cold. Then FREEZE the env.

**B-hero — The recorded demo rehearsal + take** `[frontend/Chrome + MetaMask, ~60-90 min]`
- P7.3 full story as a user, screen-recorded; P2.5 (live stream visible); P3.2-lite (create via wizard on camera if B-3 chain-picker gap allows — else the documented API-create + cockpit-visible beat).
- Pre-flight: Zerion/Blowfish domain-safe report; MetaMask on RH; `screencapture -v` take management.
- Exit: a usable .mov of the hero + a list of any demo constraints.

### ── TRACK 2: EXTENSIVE (tonight if time, else post-demo — campaign continues) ──

**A3 — Direction, status, chaining** `[backend, ~45 min]` — P4.1–P4.4 + C12–C14 mechanical.
**A4 — ACP triangle** `[backend, ~45 min]` — P2 for requester/provider/evaluator; C18; TestUSD 0xbeeA…4e52 mint; settle via API approval; F4 fee-from-spec adversarial.
**A5-full — Capabilities/JIT + networks** `[backend, ~45 min]` — P5.1–P5.4, P6.2–P6.4, C15–C17 remainder.
**A6 — Alerts, digest, audit, SSE, telegram** `[backend, ~30 min]` — C19–C21, C10; B-6 digest probe; F-3 audit-flush follow-up.
**B1 — Fresh-user journey** `[frontend]` — login → P3 full funnel (all roles × 3 paths) → fund → run → liveness from the user's seat.
**B2 — Walls as a user** `[frontend]` — over-cap, quota, approvals, injection in every field, stale states.
**B3 — Coordination + direction UI** `[frontend]` — links/pair view/delegation timeline; direct box; status chat; chain plan editor.
**B4 — Cross-chain + capabilities UI** `[frontend]` — networks panel onboard; JIT cards; preset picker; deep-link ?jit=.
**B5 — Daily loop UI** `[frontend]` — inbox, digest, settings, telegram link/ping, audit decrypt.

**Fix rounds** interleave per DELIB LAW #9: build on this chat's model → independent distinct-model review → DISAGREE→fix→AGREE → commit. Current open findings F-1 (revoke watcher chunking — HIGH, demo-relevant), F-2 (per-chain session dust), F-3 (audit flush bad-point) + B-3…B-6.

### Claude-in-Chrome protocol (all B-stages)
- **UI-only while user-simulating.** No API calls during a B-stage run — the campaign restarted
  over exactly this. Sanctioned exception: logged between-takes stimulus with no UI (e.g. mock
  feed price moves), announced in the findings log, never mid-take.
- **Browser**: Dami's real Chrome via claude-in-chrome MCP. Fresh tab per session
  (tabs_create_mcp); never reuse stale tab IDs across sessions.
- **Wallet**: MetaMask only (Zerion uninstalled/disabled — scanner false-positive + injection
  conflict). Testnet approvals pre-authorized: Claude approves in-page prompts itself; the
  MetaMask OS-level popup has no tabId → unreachable → ONE-line ping to Dami per occurrence.
- **Login**: Privy on the preview domain may need a fresh session → Dami's action (email/OTP).
- **Known quirks**: React ignores synthetic ref-clicks sometimes → use coordinate clicks;
  chrome:// pages unreachable; two-extension injection conflicts caused past "Waiting for
  MetaMask" stalls.
- **Recording (B-hero)**: `screencapture -v` from Bash (same engine as cmd+shift+5), start/stop
  around takes; retakes cheap; Dami reviews the .mov and calls retakes.
- **Dami touchpoints**: MetaMask OS popups · Telegram phone taps · Privy login · phase gates ·
  any Cloudflare/OAuth wall (Claude never completes bot-checks).

### Chat convention (Dami-confirmed)
Track 1 runs in ONE chat (shared live state: campaign owners, fixtures, env, findings-in-progress;
deadline makes handoff overhead expensive). Track 2 + every fix round follow the standard leash-0g
pipeline-chat convention: each stage in its OWN fresh chat via the kickoff template below, Dami
gates between stages, fix rounds per DELIB LAW #9 (build → independent distinct-model review →
DISAGREE→fix→AGREE → commit). This doc + tasks/e2e-rh-findings.md are the rolling context; if a
Track-1 handoff becomes unavoidable, /handoff + the template resumes cleanly.

### New-chat kickoff template
> RH2 campaign stage <ID> — read docs/RH2-E2E-CAMPAIGN-STRUCTURE.md + docs/RH2-E2E-TEST-PLAN.md
> on hackathon-robinhood; env + fixtures per Structure §Run-stages; execute stage <ID> exactly,
> log to tasks/e2e-rh-findings.md under "### Stage <ID>", liveness bar = action within one loop
> cycle, wallet autonomy per kickoff doc, UI stages are frontend-as-user ONLY (no API while
> user-simulating). Present findings to Dami at stage end.

### Tonight's recommended order (deadline EOD)
1. A2 (liveness + cage, band-hero on RH) → fix anything that blocks a visibly-alive agent.
2. A5-hero (band + portability beats, through the product's governed path).
3. A3-lite + C10-lite (direction/status/telegram demo beats).
4. B0 (every-screen smoke on the preview) → ENV FREEZE.
5. B-hero (recorded demo).
6. Then as time allows: A3-full/A4 → Track 2.
Packaging/submission artifacts come from B-hero's recording + evidence JSONs.
