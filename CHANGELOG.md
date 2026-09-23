# Changelog

LEASH is built in phases, each ending in a scope + build review gate and proven on the 0G Galileo testnet (chain 16602) before the next begins. This log tracks those phases.

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
