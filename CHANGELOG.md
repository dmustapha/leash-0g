# Changelog

LEASH is built in phases, each ending in a scope + build review gate and proven on the 0G Galileo testnet (chain 16602) before the next begins. This log tracks those phases.

## Agent-quality — AQ-A1 per-cycle context engineering (2026-10)

- The decision loop was measured **memoryless** — working memory was written every cycle but read back by nothing, so an agent re-decided blind every 30s. AQ-A1 adds a **server-composed cross-cycle carry**: two booleans derived from the agent's OWN hash-chained traces (`recentFailureStreak`, `justToppedUp`) that the mechanical rules consume — so an agent stops re-sending a payment that just reverted, or double-topping-up a wallet it funded moments ago. Server data, same trust class as the balances; never model text, never authority.
- **Proven on the 0gm probe harness** (interleaved arms, paired by scenario, first-attempt, scored by production's own decision schema): the flag carry is correct on **100%** of the decision-flip scenarios and does no harm on the rest, with **zero truncation** and completion-token cost **below** the memoryless baseline. An earlier prose-block design regressed (40–52% truncation from deliberation inflation) and was rejected — the probe owns the design, never a hand-written wording.
- Two always-on instruments land with it: a **sense→decide boundary record** (`actionPossible`/`observedChange` per cycle) that makes "decision quality per *observed change*" a durable SQL question, and a **per-cycle input-token budget** (4096 ceiling, alert-not-clip) with capability/allowlist composition caps that curate the model's view without ever narrowing authority.
- Distinct-model Gate-② AGREE (one carry over, amended + re-verified). The carry is env-gated (`AQ_A1_CARRY=0` disables for A-B / rollback).

## Whole-project tear-apart — safety floor proven (2026-10)

- Every product stage (P1→RH2) plus four adversarial waves driven against the walls, live on testnet: stolen ops keys, hijacked session keys, forged consent, cross-chain replay, SSRF egress, grant resurrection. Verdict: **zero exploitable custody bugs; the non-custodial thesis holds live.**
- What the tear-apart proved, in one line each: funds move only via the account's own session key under on-chain caps (stolen ops key → revert on every privileged call); the audit trail is ECIES-encrypted to the owner (LEASH cannot read it); a fully prompt-injected agent cannot exceed the leash (all six money paths terminate at a contract wall); delegation carries zero on-chain authority; owner approval is causally bound to the act; a grant on chain A never authorizes chain B.
- Eight fixes shipped from the findings: owner-signed audit-pubkey rotation (NC-2), terminal `removed` grants (DM-1), signing descriptor-nonce enforcement (F′-SIGN-1), trader V4→V5 migration closing the swap-drain, cross-chain revoke fan-out (I-02), NAT64 SSRF completeness, capability cross-agent parity (D-SF3-2), elevation/direction schema-drift tolerance.
- Accepted residual (bounded, documented): off-chain consent is session-authenticated, not EVM-signed — but forged consent cannot manufacture on-chain authority; custody stays crypto-gated on-chain.

## Stage F′ — Governed signing (ERC-1271) (2026-10)

- A fourth capability beyond native transfers, governed ERC-20 calls, and external tool-use: an agent can be authorized to **sign** structured EIP-712 messages (Permit2, CoW orders) — under the same never-guess-money wall. A new account, `LeashAccountV5`, adds an ERC-1271 spine: the owner grants a per-protocol signing policy on-chain (timelocked), the agent's session key arms one specific intent, and `isValidSignature` returns valid **only** for an armed, un-expired, un-revoked digest (default-deny, fails closed on revoke/expiry).
- Never-guess-money for signatures: a descriptor-driven engine reconstructs the exact EIP-712 digest from server-pinned fields; the authority leaves (spender, amounts, recipient) are pinned from the owner's on-chain grant state, never from model text, and every signable amount is bounded by per-token caps the agent cannot exceed.
- Three protocol families, each proven on a live testnet by arming an intent and reading back the ERC-1271 magic value: **Permit2** (single, nested, and `PermitBatchTransferFrom` with a reviewed per-token cap allowlist committed on-chain as a hash), **CoW Protocol** `GPv2Order` (no-spender role model, proceeds token wall-pinned), and an optional **co-signer second factor** — a second key must approve each arm, bound to chain id + account + signing epoch so an approval cannot be replayed across chains or re-arms.
- EIP-170-safe by extraction: the signing and calldata-decoding math lives in deployed stateless helper contracts (`SigningLib`, `DecodeLib`) called via `STATICCALL` — never `DELEGATECALL`, so the no-delegatecall wall invariant holds — and a generic CREATE2 deployer pins the account and both helpers at the same address on every home chain.

## Stage F — External capabilities / governed tool-use (2026-10)

- A multi-protocol LLM gateway (an Anthropic adapter alongside the 0G-compatible one) plus an MCP transport, so an agent can reason across providers and call external tools, not only move funds.
- Tool-use is governed default-deny: every external capability is quarantined behind a just-in-time owner hold, outbound calls pass an I/O guard with SSRF egress controls, and an externally-bound Tier-2 capability must be allowlisted explicitly before it can run.
- Closes L-01: the independent skeptic evaluator's verdict is verified at the verdict gate before a release can proceed.

## Stage E — Multichain (2026-10)

- One agent, one address, many chains: the governed account is deployed at the SAME CREATE2 address on every home chain (0G Galileo 16602, Base Sepolia 84532, Arbitrum Sepolia 421614, Ethereum Sepolia 11155111) via the canonical CREATE2 deployer — identical wall bytecode, verified codehash-identical on all four.
- Governance proven chain-agnostic: the same classify→gate→wall spine enforces real protocols on Base (Uniswap SwapRouter02, Permit2, Aave v3 via ERC-4626) and two divergent bridge families (OP-stack `bridgeETHTo`/`bridgeERC20To`, Arbitrum GatewayRouter `outboundTransfer`/ArbSys `withdrawEth`) — each new family is a decoder + config, not a new enforcement path.
- Adding a chain is config, not code: a generic `EXTRA_CHAINS` table onboards further testnets as pure configuration; unregistered chains are default-denied (E-11), and a testnet-only boot guard + duplicate-chain guard run over the full chain table so no mainnet can be smuggled in.
- Cross-chain safety: bridge recipients are hard-pinned to the account's own same-address self on every leg and lane, destination chain-ids are cross-checked, and the one-shot rail's call-hash is bound to `block.chainid` so a consumed grant cannot replay on another chain.
- Final deterministic factory `0x9C10b48748Da1cA0CEE5AD7DA0725490A7d5E46f` (codehash `0x4771f057…f325`) live on all four home chains; per-chain AgentRegistry deployed per chain.

## Stage D — Governed calldata (2026-09)

- A third execution path beyond native transfers: agents may call allowlisted contract functions, but every call is decoded and bounded on-chain by a structured wall (`LeashAccountV4`) — selector + target + spender allowlists, per-call and per-window caps, per-token budgets, recipient-self pinning, and no infinite approvals.
- Never-guess-money: authority arguments (spender, recipient, amount ceilings) are pinned from the owner's on-chain grant state, never from model text; the runtime builds the call from server-held grant state.
- Just-in-time capability rail: an agent's novel over-envelope call is quarantined and raised to the owner, who can approve-once (a consumable one-shot grant) or always-allow (a standing on-chain rule) — both enforced by the contract, not the backend.
- Proven on-chain with an adversarial drill: happy governed `approve`/`deposit` land; `approve(max)`, off-allowlist spender/target, over-cap, and recipient-redirect all revert at the true boundary (selector-anchored) on a live testnet.

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
