# LEASH

**A live cockpit for on-chain AI agents you can actually trust with real money — built on 0G.**

Bind an agent, watch it reason live, step in before it spends, revoke in one move — with hard on-chain limits it can't change and a tamper-evident, owner-only-decryptable audit trail on 0G Storage.

> Phase 1 — Walking Skeleton. One LEASH-created agent (treasury-allowance task), bound + governed by a self-enforcing `LeashAccount` on 0G testnet (16602), reasoning on 0G Compute through the hardened LEASH gateway.

## Monorepo

| Package | What | Stack |
|---|---|---|
| `contracts/` | `LeashAccount` (self-enforcing constrained account: per-transfer + window caps, expiry, allowlist default-deny, native-only execute, guardian revoke-only, asymmetric timelock) · `AgentRegistry` · `LeashAccountFactory` | Solidity 0.8.30, Foundry, Slither |
| `backend/` | Hardened OpenAI-compatible gateway → 0G Compute · hash-chained tamper-evident trace + consent-before-forward · async ECIES-encrypted audit batches → 0G Storage Log Layer · LangGraph.js agent runtime · owner REST + SSE API (Privy auth) | Node 22, TypeScript, Postgres (Neon) |
| `web/` | Minimal functional cockpit: guided create → live cockpit (stream / approve / revoke) → audit (owner-client decrypt + chain verify) | Next.js, Tailwind, Privy |

## Deployments

See [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md) — 0G testnet 16602, sourcify-verified.

## Security model (Phase 1)

- The agent holds **only a scoped session key**; every spend is enforced **in-contract** — a fully hijacked agent cannot exceed caps, pay off-allowlist, or survive revoke.
- LEASH is **non-custodial and blind**: the ops key can deploy and revoke (refuse) — never spend, never govern; audit trails are encrypted to an owner-held key LEASH never sees.
- Revoke fails closed at every layer: chain (execute reverts) → runtime (halted) → gateway (token refused).

Testnet only. No mainnet funds.
