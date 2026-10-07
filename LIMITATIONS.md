# Limitations

LEASH is a work-in-progress research project. This is an honest scope boundary: what is real, what is simplified, and what is not built yet. Nothing here is hidden in the README's claims.

## Network and funds

- **Testnet only.** Everything runs on the 0G Galileo testnet (chain 16602). There is no mainnet deployment and no real-value money in the system.
- **TestUSD is a faucet token.** The settlement token is an open-mint `MockERC20`, so "paying a fee" moves testnet tokens with no economic value.

## Contracts

- **Not formally audited.** The contracts pass Foundry unit, fuzz, and invariant tests plus Slither static analysis. That is a real bar, but it is not a professional security audit.
- **One settlement token per account.** A token-capable account is fixed to a single settlement token at creation (a different token is a different account). This is a deliberate constraint, not a bug.

## Agents and verification

- **The evaluator is an LLM judgment, not a proof.** The skeptic evaluator improves the odds that bad work is rejected; it does not guarantee a deliverable is correct.
- **Reasoning quality depends on the 0G Compute models available.** Provider and evaluator use distinct models; output quality tracks those models.
- **Job definition is owner-driven.** Agents execute owner-seeded job specs; autonomous need-detection (an agent inventing its own jobs) is not built.

## Multichain / bridging (Stage E)

- **Revocation does not propagate cross-chain.** Revoking an agent acts on its home-chain
  account; a same-address account on another chain keeps its own local revocation state
  (its caps/allowlist/expiry still bound it). Wind down per chain until cross-chain
  revocation fan-out ships.
- **A governed bridge's standing recipient is always the account itself** (the same
  CREATE2 address on the destination chain). Non-self far-chain payouts require an
  owner-reviewed one-shot, and even then the runtime refuses a bridge one-shot whose
  decoded recipient is not the account (destination-chain address aliasing is not
  verifiable for arbitrary recipients).
- **The bridge pre-routing gate trusts the configured destination RPC** (E-13 sec
  L-02, accepted within the operator-config trust boundary): `assertSameAddress`
  reads factory/account codehashes + CREATE2 predictions over the destination
  chain's configured RPC. A fat-fingered or hostile `*_RPC` pointing at a different
  live chain is a config-integrity risk, not a session-key exploit; an `eth_chainId`
  cross-check against the configured id is a recommended SE-9 hardening.
- **`remoteToken` on an ERC-20 bridge is not owner-pinned** (E-13 sec L-01): a wrong
  `remoteToken` can strand the near-side funds until message replay/refund — agent
  griefing / operational delay, not theft. A `localToken→remoteToken` config pairing
  is a candidate SE-9 hardening.
- **The multichain runtime requires the chain registry to be wired** (`resolveChain` +
  `chainRegistry`); a deploy that omits it falls back to the single default chain and
  allows no bridging (fail-closed).
- **Arbitrum `outboundTransfer` budget-key doctrine (SD-E13, SE-10 carry correction).**
  The in-code comment on the `SEL_OUTBOUND_TRANSFER` branch (`LeashAccountV4.sol`
  `_checkStructuredArgs`) states that an unconfigured remote token "already reverts
  BudgetNotSet". That is accurate only for a bridged **`amount > 0`**: the shared debit
  path guards `if (chargeable > 0) _debitSpendBudget(...)`, so an **`amount == 0`**
  `outboundTransfer` to an *unconfigured* `l1Token` skips the budget check and does NOT
  revert. This is a comment/accounting-accuracy note, **not an over-spend or
  fund-loss**: a 0-amount withdrawal moves no funds, the recipient is still hard-pinned
  to `self`, and both the per-call and window caps bind for every `amount > 0`. The
  Arbitrum family INTENTIONALLY keys the budget by the destination `l1Token` (the only
  token id in its calldata — there is no separate L2 `remoteToken` arg to pin as there
  is on `bridgeERC20To`), so for `amount > 0` the budget key doubles as the
  remote-token pin. The correction is recorded here (and in `07` SD-E13) rather than in
  the contract source **by design**: editing even a comment changes the Solidity
  metadata hash → the account/factory codehash → it would make the SE-9-deployed,
  cross-chain-codehash-identical wall non-reproducible and force a redeploy. SE-10 is a
  config/thin-repeat slice and must not be a contract change, so the deployed
  (semantically-correct) wall is left byte-identical and the doctrine is corrected in
  the docs that auditors read.

## Infrastructure

- **State lives in a managed Postgres (Neon).** The backend is stateless and re-derivable from chain + storage, but the projection/read model is a conventional database, not itself on-chain.
- **Audit trail is on 0G Storage, encrypted to the owner.** Integrity is chain-verifiable by anyone; contents are decryptable only by the owner.

## Product surface

- The owner UX is functional and improving; some flows (token-policy post-create edits, richer analytics) are still being built out.
- This is an evolving codebase with a living README; treat any single snapshot as a point on the roadmap, not a finished product.

- **SE-10 cosmetic carries (Stage-E close, non-blocking; master Gate-② PASS-WITH-CARRIES).**
  (1) `registryAddr` / `SEPOLIA_CAP_*` / `canonical` config values are not lowercased in
  `buildChainConfigs` (harmless — these are compared/stored as given, not used as map keys);
  (2) the `EXTRA_CHAINS` `>32`-entry upper bound is enforced but untested; (3)
  `ARB_PROTOCOL_ALLOWLIST` parsing duplicates `parseAddressList` instead of reusing it.
  All three are cosmetic (no behavior/security impact) and deferred past Stage-E close.

## RH slice — oracle-aware price band (Arbitrum Open House, branch `hackathon-robinhood`)

- **Price-band coverage is per-`(target, SEL_SWAP)` rule; the latch scopes to the canonical
  swap selector (F-1, INFORMATIONAL — 2nd security review).** `requireBandForSwap` makes any
  `SEL_SWAP` call without a band revert `BandRequired`, but it does NOT price a *different*
  router trade selector (e.g. `swapExactTokensForTokens`). Reaching such a path requires an
  owner grant (agent cannot self-grant) and the off-chain gate must continue to default-DENY
  non-`SEL_SWAP` router trade selectors. The on-chain guarantee holds exactly as stated: an
  agent cannot land a premium/stale trade on a banded swap rule.
- **The `requireBandForSwap` latch is one-way (F-2, LOW, accepted).** Irreversible by design
  (a security tightening, matching the project-wide tighten convention). A mis-pinned/dead feed
  can brick swaps on that rule until the owner re-points it (timelocked) or removes the rule;
  owner-only, never agent-triggerable, owner withdraw path unaffected.
- **Feed decimals pinned at grant, not at read.** `_assertFeedEightDecimals` asserts 8dp when a
  band is granted. Real Chainlink aggregators have immutable `decimals()`, so this is sound; a
  non-8dp or dead feed is refused at grant (fail-loud).
- **Mainline gate still pending (post-deadline).** The sprint ran a full adversarial test suite
  (349/349) + two independent security reviews (HIGH findings fixed). A clean whole-contract
  SMTChecker pass + formal mainline merge gate are deferred; the branch stays OFF mainline.

## L-RH2-1 — Trader swap recipient is UNPINNED and size UNBUDGETED on-chain (V4); backend-only guard; fixed in V5 (F′)
**Corrected 2026-10-07** per the independent Gate-② (`~/0g-fleet/docs/phases/RH2-REVIEW.md`); the earlier
"recipient pinned to self / no exfil" wording was FALSE against the contract.

`swap` is a **non-structured** governed call: `SEL_SWAP` is absent from `LeashAccountV4._checkStructuredArgs`,
so a swap hits the fallback `return(value, address(0), false)` and `_checkRecipient` is **never invoked for a
swap** (it runs only at `:565/575/599` for approve/transfer/bridge; `_checkPriceBand` reads calldata offsets
36/68/100 and never offset 132, the recipient). Net on-chain residual on V4:

- **Recipient is UNPINNED** — a swap's output can be directed to an arbitrary address by whoever controls the
  session key; the wall does not re-enforce it.
- **`amountIn` is UNBUDGETED** — per-call cap / per-token budget / window cap do not debit the swap input leg
  (the band wall gates swap PRICE, not SIZE); the per-trade clip lives only in the backend
  (`backend/src/runtime/treasury-graph.ts` clip check).

**Value-at-risk on a compromised session key = the standing router ERC-20 allowance** (itself approve-budget-capped):
a key can swap account funds at a fair in-band price and send the output anywhere, up to that allowance. The LEASH
backend DOES pin recipient to self (`backend/src/governed-call/call-builder.ts:118-128`), so the shipped product
path is safe — but the **on-chain wall, which is the stated guarantee (`00 §6c`), does not hold for the swap path.**
This is an OPEN spine residual, not a mere risk-parameter bypass.

**Mitigation while V4 is live:** keep each trader account's router ERC-20 allowance tight (≈ one clip) with a short
window, so the bounded loss is minimal until V5 ships.

**FIX:** `LeashAccountV5` (Stage F′) makes swap structured — add a `SEL_SWAP` branch to `_checkStructuredArgs`
that pins `recipient` (offset 132) via `_checkRecipient` AND charges `amountIn` against `spendBudget[tokenIn]`
+ per-call cap + window. See `~/0g-fleet/docs/phases/STAGE-F-PRIME.md` FP-CARRY-1.

**✅ LANDED in V5 (FP-1, 2026-10-07, branch `stage-f-prime-signing`):** `LeashAccountV5._checkStructuredArgs`
now has the `SEL_SWAP` branch (decodes the static 6-arg swap, pins `recipient` @132 via `_checkRecipient`,
charges `amountIn` @68 against `spendBudget[tokenIn]` @4 + per-call cap + window). Both open rows (swap-exfil +
swap-size) are CLOSED on-chain for V5 accounts. Tests: `contracts/test/LeashAccountV5.carries.t.sol`
`test_CARRY1_swapRecipientRedirect_reverts` / `swapAmountInChargesTokenInBudget` / `swapOverPerCallCap_reverts` /
`swapOverCumulativeBudget_reverts` / `swapNoBudget_reverts`. **V4 remains immutable + untouched** — existing V4
accounts keep this limitation and the backend recipient-pin + tight-allowance mitigation; migrate value to V5
accounts to inherit the on-chain fix. Also note V5 does NOT redeploy V4 (new version, new CREATE2 address).
