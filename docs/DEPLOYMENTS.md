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

## Stage D — governed calldata (v4) deployed (2026-09-27) — D-15 milestone
First contract change since Phase 4. Legacy `LeashAccountFactory` (v3) UNCHANGED; v4 gets a
DEDICATED factory (`LeashAccountV4Factory`) because a combined v3+v4 factory exceeds the
EIP-170 24,576-byte limit (33,852 > 24,576 — caught by the deployed drill; regression-guarded
by `test_factory_underEip170SizeLimit`). Chain 16602. Deployer/ops `0xc211C942946011859ca634F22400d80570ED12A5`.
- **LeashAccountV4Factory:** `0x037537a84560aEb359d989A940c5980f6CA602B1`
- **MockERC20 (TUSD-D):** `0xf936390897f72A92c8B008A1371bb54a606E5451`
- **MockRouter:** `0x4CD6ed4E6abd715D10E49AD99d2e3866bF46ee30`
- **MockVault:** `0xf951F8655C0a549c6187aB4b6Aec9fE76E402e2d`
- **Drill account (v4, timelockDelay=0 for the drill):** `0x47E5c2665E00D224527c128919c942eCeF1cEc0F`
  - granted: target=TUSD-D · selector=approve · spender=MockRouter · perCallCap 200e6 · windowCap 400e6 · budget 500e6

### D-15 deployed ADVERSARIAL drill (`contracts/script/adversarial-drill.sh`) — 6/6 PASS live
- HAPPY governed `approve(router,100e6)` landed: `0xe925b4794e4a238295b413f703255aa0f1e6ee0dd53183ad936c07d476b6a8b5` (allowance=100e6)
- MALICIOUS reverts live (eth_call, exact error selectors): `approve(max)` → `InfiniteApprovalForbidden` 0xcd9e3525 · off-allowlist spender → `SpenderNotAllowlisted` 0x6eed196c · over per-call cap → `OverPerCallCap` 0x2671b8a6 · off-allowlist target → `TargetNotAllowlisted` 0x042a9b0d
- MALICIOUS `approve(max)` real tx reverted on-chain. Evidence: `docs/evidence/stage-d-adversarial-drill.json`.

Note: the v4 account `execute(data≠0)` still reverts `CalldataForbidden`; governed calldata is a THIRD path. Contract sourcify verification: pending (0G sourcify endpoint).

## Stage D — cfabfdb REDEPLOY (2026-09-28) — C-D3 (post-FIX-1 bytecode, the wall changed)
The Gate-② fix pass (`cfabfdb`, FIX-1 on-chain `deposit` structured decoder) changed the
`LeashAccountV4` bytecode; the prior deploy (`0x47E5c2…`) + its 6/6 adversarial / 5/5 JIT drills
ran on PRE-FIX bytecode and are now STALE. C-D3 redeploys the fixed bytecode via a fresh
`LeashAccountV4Factory` (the account creation code is inlined into the factory, so the fixed
account bytecode requires a fresh factory — the prior `0x0375…` factory embeds pre-fix bytecode).
Chain 16602. Deployer/ops `0xc211C942946011859ca634F22400d80570ED12A5`.
- **LeashAccountV4Factory (cfabfdb):** `0x70673e447CbE7B11B5193BDb047677cE29ECcf8c`
  - deploy tx `0xca207b4d51bfb1b4a58684dbe6c683461f6a17dff4c2fcff4ceb085a90316f46`
- **MockERC20 (TUSD-D):** `0x4E51f90C8Cf60307E01A6abF555762e69Ef0eC2A` — deploy tx `0xa3636f899f868c06ac8cb9ddbd8400e81ddd32975e469da7e5e7e96290084ca0`
- **MockRouter:** `0x425B8638e1B851486F397715EA414d52A1Ab7a65` — deploy tx `0x037f695f3b87471cddee7fc36336f7ca6539ec457b165a7cf2d7a39c587d3cfe`
- **MockVault:** `0x6F370dd513bF45D69178cb2E1BEe2BF15bAFCE87` — deploy tx `0xb5e2543bf5163baeb54d23682710035fbcc6cb87986d8fe4e8d85a762ccade6b`
- **Drill account (v4, cfabfdb, timelockDelay=0):** `0x2FDbfa0e76D4dC455C95C4e7d445595E714cDCDF`
  - create tx `0xb21bf3f2d81d9167350e00eaa1699cca819a0f75b95290be41fad4c08288fa84`
  - grants: `approve` (spenders MockRouter+MockVault, perCallCap 200e6/window loosened) + `deposit`
    (MockVault, recipientMode=self, perCallCap 200e6/window loosened) + per-token budgets (usd/vault).
    NOTE: a mid-deploy tx was dropped by the 0G RPC (external roughness, surfaced) → the vault
    budget + approve/deposit rules were completed via `cast` (owner txs, timelockDelay=0).

### C-D3 deployed ADVERSARIAL drill (extended with the FIX-1 deposit decoder) — 9/9 PASS live
`contracts/script/adversarial-drill.sh` @ `0x2FDbfa…`:
- HAPPY governed `approve(router,100e6)` landed (allowance=100e6) tx `0x85c4e3b6…`
- MALICIOUS reverts live (eth_call, exact selectors): `approve(max)` → `InfiniteApprovalForbidden` 0xcd9e3525 · off-allowlist spender → `SpenderNotAllowlisted` 0x6eed196c · over per-call cap → `OverPerCallCap` 0x2671b8a6 · off-allowlist target → `TargetNotAllowlisted` 0x042a9b0d
- MALICIOUS `approve(max)` real tx mined status=0 (reverted on-chain) tx `0x3a2d1c78…`
- **FIX-1 deposit decoder (the wall that changed):** deposit redirect `deposit(100e6,ATTACKER)` → `RecipientNotSelf` 0x239e7696 · deposit over-cap `deposit(300e6,self)` → `OverPerCallCap` 0x2671b8a6 · **HAPPY `approve(vault)→deposit(100e6,self)` settled + credited shares to self** (shares +100e6; approve tx `0x70b78469…` deposit tx `0x667123fe…`). Evidence: `docs/evidence/stage-d-adversarial-drill.json`.

### C-D3 deployed JIT-rail drill (on-chain grant primitives) — 5/5 PASS live (re-run on new bytecode)
`contracts/script/jit-drill.sh` @ `0x2FDbfa…`: over-cap out-of-envelope reverts · **approve-once** one-shot retry landed `0x6f3c5d52…` (allowance 250e6) + replay refused (consumed) · **always-allow** loosen `proposeCallRule`→`applyCallRule` → standing retry landed `0x74a8147b…` (allowance 300e6). Evidence: `docs/evidence/stage-d-jit-drill.json`.

### C-D1 backend-orchestrated JIT E2E (always-allow) — ✅ 1/1 PASS live
`backend/test/integration/governed-call-deployed.test.ts` (RUN_DEPLOYED_DRILL=1) — the REAL runtime (`SessionChain` vs 0G + hermetic Neon schema) drives the full loop against `0x2FDbfa…`: agent novel over-cap call → runtime L2 raise (quarantined `capability_request` + alert, no submit) → owner always-allow (on-chain loosen `proposeCallRule 300e6`→`applyCallRule` + `decideCapabilityRequest`) → next cycle runtime L1 `executeCall` **landed on-chain** tx `0x083ce663…` (allowance 250e6). Fail-safe: an intermediate 0G receipt-fetch flake was recorded failed-not-acted. Evidence: `docs/evidence/stage-d-cd1-jit-e2e.json`. NOTE: approve-once is proven as an on-chain primitive (jit-drill 5/5), not a backend retry (finding F-D2 in `07`/DEPLOY-RESULTS).

## Stage E — SE-6 deterministic (CREATE2) V4 factory (2026-09-29) — SAME address on 2 chains
The SE-6 same-address layer: `LeashAccountV4FactoryDeterministic` deployed at the **SAME address on
both chains** via the canonical CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`
(salt `keccak256("LEASH-V4-DETERMINISTIC-FACTORY-v1")`). The embedded `LeashAccountV4` creation code
is the cfabfdb wall bytecode (codehash-equality vs the plain factory proven in Foundry). Deployer/ops
`0xc211C942946011859ca634F22400d80570ED12A5`.
- **LeashAccountV4FactoryDeterministic:** `0xa0249c5808E8F3b31d406d1eF6492B4508014dA0`
  - 0G Galileo 16602 — deploy tx `0x9d9860f2c4277a2196fd4ac9f479b8b450908ea7f0996e19ddc72f6a79d592a6`
  - Base Sepolia 84532 — deploy tx `0xd1f180555d0b5a1714221831bbe3dca19e7cacc74f86fcf005c6fa4e0fdb66fd`
- **BR-1 config swap:** `LEASH_FACTORY_V4_ADDR=0xa0249c5808E8F3b31d406d1eF6492B4508014dA0` (staged in
  backend/.env; set the same value in the Render env at the Stage-E deploy). The V4 create wire now
  passes a server-generated `bytes32 salt` + predict-verifies the mint (`createAccountV4` 9-arg form).
- **E-6 live proof (`backend/scripts/create2-same-address-drill.ts`, idempotent + flake-tolerant):**
  the same (owner, salt) + identical construction tuple minted the account at the SAME address on BOTH
  chains — e.g. `0x71ab54697eacf7ebbafff36d1c579a9eaf22e0df` (0G tx `0xd6284c45…`, Base tx `0x6cbe4eca…`);
  two recorded back-to-back GREEN runs (8/8 each, `0x9c671424…` and `0xb905d772…`) in
  `docs/evidence/stage-e-create2-drill.json`. `assertSameAddress` verified pre+post deploy (factory addr +
  factory codehash + CREATE2 prediction + deployed account codehash), the governed-calldata wall REVERTS an
  off-allowlist `executeCall` on Base Sepolia, and a spoofed-factory config is REFUSED
  (`SameAddressMismatchError: factory_addr diverges`) by the production path.
