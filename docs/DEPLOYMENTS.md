# Deployments — 0G testnet (chain 16602)

## Phase 1 singletons (deployed 2026-09-20, sourcify-verified exact_match)
- `AgentRegistry` — `0x6C8c6df5E8FdE59330Ea309676fa280302865Ed6`
- `LeashAccountFactory` — `0x43456298A210b8571b1917593CBb9EbbA9C4BE5D`

Verification: 0G ChainScan (chainscan-galileo.0g.ai) exposes no working contract-verification
API (SPA only; `/api` + `/open/api` are not etherscan-compatible) — external 0G roughness,
surfaced per 02-BUILD-METHODOLOGY §8. Source verification done on **Sourcify** instead:
both contracts `exact_match` on chain 16602.

## Live proof transactions (D3/D5 evidence)
- Factory `createAccount` → `0x95f707762f089dc7878ed9aa79e9ebfc023a042233b3b6b3d4727d574a0b1bd9`
  - LeashAccount instance: `0x24bb3b7ce50a0b6133f60d6ca3cd45269de9c6af`
  - policy: perTransferCap 0.01 0G · windowCap 0.03 0G · window 3600s · expiry +7d · allowlist [beneficiary] · timelock 900s
- In-policy `execute` (session key, native transfer 0.005 0G) → `0x2126e0f49e336a774599549a0114f5da3b7b7585200580f03907db62ef17d2fa`
- `revoke()` (guardian) → `0x3f933efea8ed257bd99585b883880f5a5ae363f1eb292b4804300ff1825b44f3`
- Post-revoke `execute` attempt: **reverts `AccountRevoked` (0x74b17b2b)** live — fail-closed proven on-chain.
