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

## Infrastructure

- **State lives in a managed Postgres (Neon).** The backend is stateless and re-derivable from chain + storage, but the projection/read model is a conventional database, not itself on-chain.
- **Audit trail is on 0G Storage, encrypted to the owner.** Integrity is chain-verifiable by anyone; contents are decryptable only by the owner.

## Product surface

- The owner UX is functional and improving; some flows (token-policy post-create edits, richer analytics) are still being built out.
- This is an evolving codebase with a living README; treat any single snapshot as a point on the roadmap, not a finished product.
