# Deployments — 0G testnet (chain 16602)

## Current singletons (v2, 2026-09-20 — post gate-review fixes; sourcify exact_match)
- `AgentRegistry` — `0xA74d573F43CFDA890713Bd348186ab80736642C3`
- `LeashAccountFactory` — `0x5100f7a9661F56842342C21aAAc15169A7fD3c52`

v2 changes vs v1 (security-gate items): `revoke()`/`tightenPolicy()` clear all pending
timelock slots (L-05); NatSpec states the fixed/tumbling-window semantics honestly —
worst-case burst across a window boundary is ≤2× `windowCap` (M-02, pinned by
`test_execute_boundaryBurst_upToTwiceWindowCap_isAcceptedTumblingSemantics`).

Verification: 0G ChainScan exposes no working contract-verification API (SPA only) —
external 0G roughness, surfaced per 02-BUILD-METHODOLOGY §8. Source verification is on
**Sourcify** (`exact_match` both contracts).

## Live proof transactions — v2 factory (D3/D5 evidence)
- `createAccount` → `0xcd7f5017ff917f621c109de68b95793479e6eba1f06d48157121306a34876361`
  - LeashAccount instance: `0x809d6354617a7dc213507758f447d5a2ddc01c86`
  - policy: perTransferCap 0.01 0G · windowCap 0.03 0G · window 3600s · expiry +7d · allowlist [beneficiary] · timelock 900s
- In-policy `execute` (session key, native 0.005 0G) → `0x0f5c47db11eb0567ae3cf975769bcc68074ec76c195646d133aeafe1085856fd`
- `revoke()` (guardian) → `0x3d5539482ae573ab11e64977635ee3a568d8e5815308ccb37430e5fd5d402b96`
- Post-revoke `execute` attempt: **reverts `AccountRevoked` (0x74b17b2b)** live — fail-closed proven on-chain.

## Superseded (v1, same day — pre gate fixes; kept for audit continuity)
- `AgentRegistry` `0x6C8c6df5E8FdE59330Ea309676fa280302865Ed6` · `LeashAccountFactory` `0x43456298A210b8571b1917593CBb9EbbA9C4BE5D`
- v1 proof: create `0x95f707…b1bd9` · account `0x24bb3b…c6af` · execute `0x2126e0…d2fa` · revoke `0x3f933e…44f3` · post-revoke revert `AccountRevoked`.

## Services
- Backend (Render, free tier — stateless, all state in Neon): `https://leash-0g-backend.onrender.com`
- Frontend (Vercel): project `leash-0g-web` (stable alias on promote)
- CI wallet (GitHub secrets, low-value): `0x277cD0ee8e22dF1249D315d2e3e0FeBa70017375` (funded 0.3 0G, tx `0xa4ecfb…02c5`)
