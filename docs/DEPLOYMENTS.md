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

## v3 redeploy — token-capable factory + TestUSD (2026-09-23, Phase-4)
Factory v3 adds settlementToken + TokenPolicy (native-only = `address(0)`; legacy v2 unaffected).
AgentRegistry is UNCHANGED (stores no policy — the v2 registry above stays canonical).
Deployer: ops key `0xc211C942946011859ca634F22400d80570ED12A5`. Chain 16602. Sourcify `exact_match` (creation + runtime) on both.

- `LeashAccountFactory` (v3) — `0xcD7818673238E2703585CF96658FeBf1a10f8105`
  - deploy tx `0x416f41298db07b742dde4892c0178bfa52095d4fa5a9388c1d642c7abf4d347a` (block 56334196, status 0x1)
- `MockERC20` (TestUSD, 6dp, open faucet, test-labelled) — `0xbeeA96c7614ebc46760B442068E359e51e7c4e52`
  - deploy tx `0x3d5dc19c2e57eafe86d0363eab362fede510565838186cb0ab10de3d0e1de5d5` (block 56334210, status 0x1)

## Superseded (v1, same day — pre gate fixes; kept for audit continuity)
- `AgentRegistry` `0x6C8c6df5E8FdE59330Ea309676fa280302865Ed6` · `LeashAccountFactory` `0x43456298A210b8571b1917593CBb9EbbA9C4BE5D`
- v1 proof: create `0x95f707762f089dc7878ed9aa79e9ebfc023a042233b3b6b3d4727d574a0b1bd9` · account `0x24bB3B7CE50A0B6133F60D6CA3cd45269DE9c6Af` · execute `0x2126e0f49e336a774599549a0114f5da3b7b7585200580f03907db62ef17d2fa` · revoke `0x3f933efea8ed257bd99585b883880f5a5ae363f1eb292b4804300ff1825b44f3` · post-revoke revert `AccountRevoked`.

## Services
- Backend (Render, free tier — stateless, all state in Neon): `https://leash-0g-backend.onrender.com`
  - **Deploy strategy (P3C-5/S13, pinned): NON-OVERLAPPING.** On the free tier Render stops the
    old instance before starting the new one (zero-downtime overlap is a paid-tier feature), so
    two instances never run at once — the boot-sweep cannot fail a delegation genuinely in flight
    on a draining instance. **If the service is ever upgraded to a paid tier, Render defaults to
    overlapping zero-downtime deploys — re-evaluate this pin (or accept the traced boot-sweep
    artifact) before upgrading.** Recorded in `07` S13.
- Frontend (Vercel): project `leash-0g-web` (stable alias on promote)
- CI wallet (GitHub secrets, low-value): `0x277cD0ee8e22dF1249D315d2e3e0FeBa70017375` (funded 0.3 0G, tx `0xa4ecfb2d8f987d0e248bcd8be021fc97471c76aff483574abfcac6c883dc02c5`)

## Phase 2 — Second Agent + Coordination (2026-09-21, commit 0b00891)
Contracts UNCHANGED (v2 singletons above; 57 forge tests incl. new expiry/spend-incapable pins).

- **Guardian lane key (C-1, S5):** `0xE1Aea125807e1d46afFfbee8C2d5C00F124c01a1` — revoke-only,
  gas-dust-funded 0.05 0G (tx `0xdc331ca87813a359481dec1f4a0288fcc263f760794dd44da8e13b77cdcd9c18`). New accounts get it as guardian; legacy
  accounts keep the ops-key guardian (S7 lane selection).
- **Restricted runtime DB role (C-6):** Render runs as `leash_runtime` (no DDL/TRUNCATE;
  trace_records append-only at the grant layer); admin URL retained as MIGRATE_DATABASE_URL.
  Provisioning/rollback: `backend/docs/RUNTIME-DB-ROLE.md`.

### P0 deployed approval drill (spec §2a)
- approve run: consent seq 0 < action seq 2, act tx `0x224ce7e7ef5921b26c152eb82d37eb44302928176e5e801a5e580c3808cb13f4`
- deny run: consent seq 3, refusal seq 4, no action
- probe: owner tighten `0xf9fd0f39b94aca457d23f1d361b24b5d14224bac1ce82211e680c5886d5017b8` → model clamped to the new cap (acted 0.001 0G, in-policy)
- teardown revoke fail-closed; fixture deviation (create validation rejects topUp>cap) recorded in PHASE-2-RESULTS.

### D2 deployed pair E2E (coordinated governed action, live)
- sentinel `0x97707d8d1d3c5a37078c00a524094506ec907cfa` (zero caps, empty allowlist) → executor `0xcbcaf47254041012f2714b1955a849f9dba1c1e9`
- delegation `b8648aa3-019e-47f6-ba48-67ef5f3a316f` pending→accepted→completed
- REAL act via executor's LeashAccount: `0xf3e61c52be3442b850752252a9f4a881ffd53d198ee534468caa220bc965a34f` (0.002 0G)
- both chains verified, same delegationId; REVOKE PAIR txs
  `0xc5cbead1e5772eccb2c6ff6b356fbdaa158e75dcf654658b541d9467e60c3dd5` + `0xed6164945409a9e636d176fdd30e74909b12bc78d8e0653e954cbe2bc1f93672`, both `revoked()==true` live.

### Post-role-swap deployed E2E (Phase-1 loop re-proof as leash_runtime)
- act `0x7538aa5b3888ecaf048d3105f5d10aaf66b5a7e80da3777a197b78e326626ad4`, revoke fail-closed, 1 audit batch sealed.

CI: run 35595910553 — all 7 lanes green on head-of-main (incl. live-0G lane, 13/13).

## Phase-5 create-funnel deployed drill (2026-09-25) — D-A5/D-B7 live evidence
Merged to `main` @ `2cefb83`; Render+Vercel auto-deploy (migration 013 `capability_label` on boot).
Drill: `backend/scripts/deployed-create-funnel-drill.mjs` (real Privy-SIWE throwaway owner, real 0G Compute).
- owner (throwaway): `0x44bE4EC7486B2217C073D6B1EB0B77bE33d5A74f`
- elevate → `provider` draft (confidence high, label "research summarizer"), NO address in draft (never-guess-money)
- quarantine: 0 agents before confirm (`/elevate` wrote nothing)
- confirm→create agent `05be412e-5008-4c4e-8331-831922d0f880`, account `0xCF96738724A8C7DD4DC394a5dBf0344dE9A8986c`
  - create tx `0xcd09d7f7df747a99a9378967c33e8cc03fb5110719371707d621d1bb93254de2`
  - register tx `0x52b9eaafac2c38b8c605cbb295a51630a47a49c09ed8786de9349e460aa8e1a2`
- capabilityLabel round-tripped in cockpit detail; agent operable (paused). Evidence: `docs/evidence/phase5-deployed-drill.json`.
