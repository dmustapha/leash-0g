# Changelog

LEASH is built in phases, each ending in a scope + build review gate and proven on the 0G Galileo testnet (chain 16602) before the next begins. This log tracks those phases.

## Phase 5.6 — Agent chaining across capabilities (2026-09)

- Direct one of your agents to hand its result to another of your OWN agents: a confirmed directive can carry an owner-authored chain plan ("run my analyst, then hand the finding to my trader"), built in the same read-back, one confirm.
- Each hop is a supervised delegation on a link you already made; the downstream re-reasons on the upstream's output as untrusted input under its OWN on-chain leash. A chained agent still cannot invent a payment, exceed a cap, pay off-allowlist, or survive a revoke.
- Owner-only origin, single-owner scope: a hop can originate only from your directive + your approval, never from agent output. Each hop's targets are an owner-authored shortlist of your own linked agents (never a model-authored address); at runtime the upstream picks one, re-validated server-side to that shortlist — a hijacked agent can never reach an off-list target.
- Any hop that can move money asks for your approval (reusing the existing handoff card); analyst-style hops that can't spend flow automatically, still leash-bound. Chains are bounded and acyclic (depth cap, per-hop shortlist cap, cycle prevention) and halt on revoke or wind-down.
- Built entirely on the existing links/delegations + job-envelope substrate as a runtime read-model projection — no new on-chain enforcement, zero contract change.

## Phase 5 — Create funnel (2026-09)

- Intent-first create funnel: describe an agent in plain words, an LLM on 0G Compute elevates it into a draft, and a tiered read-back shows exactly what was understood before anything is created. Two screens on the happy path; templates and a manual escape for experts.
- Quarantine boundary: elevation only proposes — it writes nothing; authority is persisted only when the owner confirms on the existing create path.
- Never-guess-money: elevation never emits a wallet address (always owner-typed, blank-required) and never pre-fills a fee unless the owner's own words stated one; a plain-language money-power line makes a wrong-role draft catchable.
- Create-flow cleanup: the two-sided requester role is demoted behind an advanced door until its prerequisites exist, and its job handle is a picker over saved job specs (no more free-text dead-end).
- On-chain leash audit: every enforcement path documented against its revert, its covering test, and its cockpit surface; enforcement unchanged.
- Proven on the live stack: intent to elevation on real 0G Compute to a confirmed on-chain agent, end-to-end.

## Phase 4 — Real use-case: agent commerce (2026-09)

- Requester / provider / evaluator agent triangle running a real job end-to-end.
- Owner-seeded job specs (question + acceptance rules + fee) held in server state, never trusted from agent output.
- Deterministic acceptance floor, independent skeptic evaluator, and a layered release gate (floor, then verdict, then owner approval), each of which alone blocks release.
- Governed ERC-20 settlement via token-capable v3 contracts and a `TestUSD` settlement token; multi-party proof-of-agreement written to 0G Storage.
- Asset-aware settlement UX: the approval surface detects and labels the true asset (native 0G vs the ERC-20) instead of assuming 0G.
- Proven on-chain: governed settlement tx `0x23d7deb710740d167c9b9699278c63bcd73b1e49e9beabd522a8460df3b13c97`.
- New v3 deployments: factory `0xcD7818673238E2703585CF96658FeBf1a10f8105`, `TestUSD` `0xbeeA96c7614ebc46760B442068E359e51e7c4e52`.

## Phase 3 — Daily loop (2026-09)

- Alert engine and an aggregated owner activity stream.
- Real Telegram bot: link flow, minimal-disclosure push, and inline approve/deny on the same consent rails as the app.
- Daily digest service, spend-window observability, plain-language decoding of every contract error, and futile-retry damping.

## Phase 2 — Second agent + coordination (2026-09)

- Multiple agents under one owner with links, delegations, a state machine, and throttles.
- Watch-only sentinel and act-on-request executor roles.
- Coordinated governed action across an agent pair, proven live.
- Guardian-key revoke lane and a least-privilege runtime database role.

## Phase 1 — Walking skeleton (2026-09)

- One owner-created treasury agent bound to a self-enforcing `LeashAccount`.
- Reasoning on 0G Compute through a hardened gateway; hash-chained tamper-evident trace; ECIES-encrypted audit trail to 0G Storage.
- Live cockpit: guided create, live stream, approve, revoke.
- Fail-closed revoke proven on-chain.
- Singletons: `AgentRegistry` `0xA74d573F43CFDA890713Bd348186ab80736642C3`.

## Phase 0 — De-risking spike (2026-09)

- Throwaway spike validating the three hard unknowns on 0G before committing to the build: the Compute gateway, ECIES-encrypted writes to 0G Storage, and in-contract spend enforcement. Learnings kept, code discarded.
