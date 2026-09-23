# LEASH

**A live cockpit for on-chain AI agents you can actually trust with real money, built on 0G.**

Bind an agent, watch it reason live, step in before it spends, revoke in one move, with hard on-chain limits it cannot change and a tamper-evident, owner-only-decryptable audit trail on 0G Storage.

LEASH lets autonomous AI agents hold and move real funds under limits the agent itself can never exceed. The agent reasons on 0G Compute, stores its work and a hash-chained audit trail on 0G Storage, and every fund movement is enforced by a self-governing account contract on the 0G chain. A human stays in the loop for the decisions that matter.

## Live on 0G (Galileo testnet, chain 16602)

- **Web cockpit:** https://leash-0g-web.vercel.app
- **Backend API:** https://leash-0g-backend.onrender.com
- **Contracts (Sourcify-verified):**
  - `AgentRegistry` `0xA74d573F43CFDA890713Bd348186ab80736642C3`
  - `LeashAccountFactory` (v3, token-capable) `0xcD7818673238E2703585CF96658FeBf1a10f8105`
  - `TestUSD` (settlement token, open faucet) `0xbeeA96c7614ebc46760B442068E359e51e7c4e52`

**Proof it runs, not slides.** An autonomous agent completed a job, its deliverable cleared an automatic acceptance floor plus an independent skeptic evaluator, a human approved the release, and the agent paid a **governed ERC-20 fee on-chain**:

| What | Value |
|---|---|
| Governed settlement tx | `0x23d7deb710740d167c9b9699278c63bcd73b1e49e9beabd522a8460df3b13c97` |
| Chain | 0G Galileo testnet (16602) |
| Result | Fee released to the allowlisted recipient, multi-party proof-of-agreement recorded |

## How it uses 0G, natively

| 0G primitive | How LEASH uses it |
|---|---|
| **0G Compute** | The agents' reasoning runs on 0G inference: a provider agent produces a work-product, an independent skeptic evaluator (a different model) judges it. |
| **0G Storage** | Deliverables and a hash-chained, tamper-evident audit trail are stored on 0G, ECIES-encrypted to an owner-held key LEASH never sees. |
| **0G Chain** | The governance contracts and every actual fund movement live on-chain: a self-enforcing account with hard caps, allowlists, timelocks, and guardian revoke. |

## What it does

- **On-chain policy engine.** Each agent's funds live in a self-enforcing `LeashAccount`: per-transfer and rolling-window spend caps, allowlist default-deny, session expiry, and a guardian revoke that fails closed. A fully hijacked agent still cannot exceed a cap, pay a non-allowlisted address, or survive a revoke.
- **Human-in-the-loop approvals.** Boundary decisions (a settlement, a policy loosening) are pushed to the owner over Telegram and the web cockpit; consent is recorded on the tamper-evident trace before any action.
- **Agent commerce loop.** A requester agent orders an owner-defined job, a provider delivers work over 0G, an evaluator verifies it, and the fee settles on-chain, each step gated: acceptance floor, then skeptic verdict, then owner approval, any one of which blocks release.
- **Owner-only audit.** The full reasoning and action trail is hash-chained and encrypted to the owner; anyone can verify integrity on-chain, only the owner can decrypt the contents.

## Monorepo

| Package | What | Stack |
|---|---|---|
| `contracts/` | `LeashAccount` (self-enforcing constrained account: native + governed ERC-20 execute, per-transfer/window caps, expiry, allowlist default-deny, guardian revoke-only, asymmetric timelock) · `AgentRegistry` · `LeashAccountFactory` | Solidity 0.8.30, Foundry, Slither |
| `backend/` | Hardened OpenAI-compatible gateway to 0G Compute · hash-chained trace with consent-before-forward · ECIES-encrypted audit batches to 0G Storage · LangGraph agent runtime (treasury + agent-commerce graphs) · owner REST + SSE API (Privy auth) · Telegram approvals | Node 22, TypeScript, Postgres (Neon) |
| `web/` | Guided create wizard, live cockpit (stream / approve / revoke), job lifecycle view, audit (owner-client decrypt + chain verify) | Next.js, Tailwind, Privy |

## Security model

- The agent holds **only a scoped session key**; every spend is enforced **in-contract**, so a hijacked agent cannot exceed caps, pay off-allowlist, or survive revoke.
- LEASH is **non-custodial and blind**: the ops key can deploy and revoke, never spend or govern; audit trails are encrypted to an owner-held key LEASH never sees.
- The fee amount and acceptance rules for a job come from **owner-defined server state**, never from agent output, and are bounded again by the on-chain per-token caps.
- Revoke fails closed at every layer: chain (execute reverts), runtime (halted), gateway (token refused).

## Running locally

```bash
git clone https://github.com/dmustapha/leash-0g.git
cd leash-0g
pnpm install

# contracts
cd contracts && forge build && forge test

# backend (needs a .env, see backend/.env.example)
cd ../backend && pnpm build && pnpm test

# web
cd ../web && pnpm dev
```

Contract addresses, RPC, and other config are in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

## Tests

- `contracts/`: Foundry unit, fuzz, and invariant tests (native + token settlement paths, every forbidden-action revert).
- `backend/`: unit and integration suites over the policy engine, gateway, agent runtime, the layered verification gate, and the governed settlement path.
- `web/`: component and accessibility tests over the create wizard, cockpit, and job lifecycle.

## Build phases

LEASH was built in deliberate phases, each ending in a scope + build review gate. Every phase shipped and was proven on 0G testnet before the next began.

| Phase | Focus | What it achieved |
|---|---|---|
| **0 — De-risking spike** | Validate the hard unknowns first | A throwaway spike proving the three risky pieces work on 0G: the hardened Compute gateway, ECIES-encrypted writes to 0G Storage, and in-contract spend enforcement. Learnings kept, code discarded. |
| **1 — Walking skeleton** | One agent, fully governed, end-to-end | An owner-created treasury agent bound to a self-enforcing `LeashAccount`, reasoning on 0G Compute through the gateway, with a hash-chained trace + ECIES audit trail on 0G Storage and a live cockpit (create, stream, approve, revoke). Fail-closed revoke proven on-chain. |
| **2 — Second agent + coordination** | More than one agent, working together | Multiple agents under one owner with links, delegations, a state machine, and throttles; a watch-only sentinel and an act-on-request executor; a coordinated governed action across a pair proven live; a guardian-key revoke lane and a least-privilege runtime DB role. |
| **3 — Daily loop** | The owner's at-a-glance layer | An alert engine + aggregated activity stream, a real Telegram bot (link, minimal-disclosure push, inline approve/deny on the same consent rails), a daily digest, spend-window observability, plain-language decoding of every contract error, and damping so a boundary-blocked agent stops retrying. |
| **4 — Real use-case (agent commerce)** | Agents that order, verify, and pay for work | The requester / provider / evaluator triangle running a real job end-to-end: owner-seeded job specs, a deterministic acceptance floor, an independent skeptic evaluator, a layered release gate (floor, then verdict, then owner approval), governed ERC-20 settlement via token-capable v3 contracts + TestUSD, multi-party proof-of-agreement on 0G Storage, and asset-aware settlement UX. Proven on-chain (see the settlement tx above). |

## Status

**Work in progress.** Phases 0 through 4 are shipped and proven end-to-end on 0G testnet.

Next: hardening the multi-agent economy, richer audit and analytics surfaces, and a continued polish pass on the owner experience.

Testnet only. No mainnet funds.

## License

MIT. See [LICENSE](LICENSE).
