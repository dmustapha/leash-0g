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

## Infrastructure

- **State lives in a managed Postgres (Neon).** The backend is stateless and re-derivable from chain + storage, but the projection/read model is a conventional database, not itself on-chain.
- **Audit trail is on 0G Storage, encrypted to the owner.** Integrity is chain-verifiable by anyone; contents are decryptable only by the owner.

## Product surface

- The owner UX is functional and improving; some flows (token-policy post-create edits, richer analytics) are still being built out.
- This is an evolving codebase with a living README; treat any single snapshot as a point on the roadmap, not a finished product.
