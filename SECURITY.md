# Security

LEASH governs autonomous agents that hold and move real funds, so the security model is the product. This document states what LEASH defends against, how, and what it explicitly does not defend against.

## Trust model

- **The owner is the only authority.** Only the owner can create an agent, set or loosen its policy, and approve boundary actions.
- **The agent is untrusted.** It holds a scoped session key, never the owner's key. Every spend is checked in-contract, so a fully hijacked agent (prompt-injected, jailbroken, or compromised at the runtime) still cannot exceed its limits.
- **LEASH is non-custodial and blind.** The operator (ops) key can deploy an account and revoke (refuse), never spend and never govern. Audit trails are encrypted to an owner-held key LEASH never possesses.

## Enforcement layers (defence in depth)

| Layer | What it enforces |
|---|---|
| Contract (`LeashAccount`) | Per-transfer cap, rolling-window cap, session expiry, allowlist default-deny, native + governed ERC-20 execute only (no arbitrary calldata), guardian revoke. These are the hard limits: they hold even if every layer above is compromised. |
| Runtime | The agent runs under its policy; a revoked or expired agent is halted. Job settlement amounts and acceptance rules come from owner-defined server state, never from agent output. |
| Gateway | Reasoning is proxied to 0G Compute through a hardened gateway; a revoked agent's token is refused. |
| Consent | Boundary actions record owner consent on a hash-chained trace before the action, over the same rails whether decided in-app or via Telegram. |

## Revoke fails closed

A revoke propagates through every layer: the contract `execute` reverts (`AccountRevoked`), the runtime halts the agent, and the gateway refuses its token. There is no layer at which a revoked agent can still act.

## Job settlement integrity

For the agent-commerce flow, the fee token, recipient, and amount all derive from the owner-seeded job spec in server state, never from any model or deliverable text. Release requires all three gate layers to pass: a deterministic acceptance floor, an independent skeptic evaluator, and an explicit owner approval. The on-chain per-token caps bound the fee again, so a hijacked requester cannot overpay or redirect a payment.

## Key handling

- The agent session key is scoped and low-privilege; losing it cannot exceed policy.
- The ops and guardian keys used on testnet are **burnable testnet keys**. No mainnet or funds-controlling key is ever placed in this repository or its environment.
- Audit encryption keys are owner-held; LEASH stores only ciphertext.

## Not defended against (honest boundaries)

- **Contracts are not formally audited.** They pass Foundry unit/fuzz/invariant tests and Slither static analysis, which is not a substitute for a professional audit.
- **The evaluator is a heuristic, not a proof.** The skeptic evaluator is an LLM judgment; it raises the bar for bad work but does not guarantee correctness.
- **Testnet only.** No mainnet deployment, no real-value funds.
- **Owner-key compromise is out of scope.** If the owner's own wallet/session is compromised, the attacker is the owner as far as the system can tell.

## Reporting

This is a work-in-progress research project on testnet. For security concerns, open an issue or contact the maintainer.
