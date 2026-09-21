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

## Phase 2 — Second Agent + Coordination (2026-09-21, commit 0b00891)
Contracts UNCHANGED (v2 singletons above; 57 forge tests incl. new expiry/spend-incapable pins).

- **Guardian lane key (C-1, S5):** `0xE1Aea125807e1d46afFfbee8C2d5C00F124c01a1` — revoke-only,
  gas-dust-funded 0.05 0G (tx `0xdc331ca8…cd9c18`). New accounts get it as guardian; legacy
  accounts keep the ops-key guardian (S7 lane selection).
- **Restricted runtime DB role (C-6):** Render runs as `leash_runtime` (no DDL/TRUNCATE;
  trace_records append-only at the grant layer); admin URL retained as MIGRATE_DATABASE_URL.
  Provisioning/rollback: `backend/docs/RUNTIME-DB-ROLE.md`.

### P0 deployed approval drill (spec §2a)
- approve run: consent seq 0 < action seq 2, act tx `0x224ce7e7ef5921b26c152eb82d37eb44302928176e5e801a5e580c3808cb13f4`
- deny run: consent seq 3, refusal seq 4, no action
- probe: owner tighten `0xf9fd0f39…5017b8` → model clamped to the new cap (acted 0.001 0G, in-policy)
- teardown revoke fail-closed; fixture deviation (create validation rejects topUp>cap) recorded in PHASE-2-RESULTS.

### D2 deployed pair E2E (coordinated governed action, live)
- sentinel `0x97707d8D…07CFA` (zero caps, empty allowlist) → executor `0xCbcAf472…A1c1E9`
- delegation `b8648aa3-019e-47f6-ba48-67ef5f3a316f` pending→accepted→completed
- REAL act via executor's LeashAccount: `0xf3e61c52be3442b850752252a9f4a881ffd53d198ee534468caa220bc965a34f` (0.002 0G)
- both chains verified, same delegationId; REVOKE PAIR txs
  `0xc5cbead1…c3dd5` + `0xed616494…93672`, both `revoked()==true` live.

### Post-role-swap deployed E2E (Phase-1 loop re-proof as leash_runtime)
- act `0x7538aa5b3888ecaf048d3105f5d10aaf66b5a7e80da3777a197b78e326626ad4`, revoke fail-closed, 1 audit batch sealed.

CI: run 35595910553 — all 7 lanes green on head-of-main (incl. live-0G lane, 13/13).
