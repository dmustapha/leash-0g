# Stage F′ FP-4 Slice-2 (P2) — GATE-② REVIEW (independent, distinct-model) — co-signer second-factor

**Verdict: AGREE** — Slice-2 may be committed (push held to end of FP-4). No BLOCKER, no HIGH. The one recommended
robustness fix (`setCoSigner` same-value guard) was **FOLDED IN post-gate (Dami ruled: fold it)** — see
"Post-gate fix" below. Remaining carries are LOW/NIT/INFO forward-safety items, all pre-`#16`, none
security-affecting while the co-signer path is inert.

**Reviewer:** Opus 4.8 synthesis + **two distinct-model Sonnet sub-agents** (`security-auditor` + `code-reviewer`)
on the cold diff, per DELIB LAW #9. *(Model-independence note: this synthesis ran on Opus — same family as the
build — a deviation Dami ratified 2026-10-08 given the security-critical re-derivation is carried by the Sonnet
agents + firsthand code reads below. The AGREE/DISAGREE wording is Opus-authored.)*
**Diff:** `git -C /Users/MAC/leash diff 38d5094 -- contracts/ backend/` · branch `stage-f-prime-signing`, uncommitted.
**Date:** 2026-10-08.

---

## Reproductions (independently re-run — all green)
| Check | Expected | Got |
|---|---|---|
| `forge test` | 448 / 0 | **448 passed / 0 failed** (22 suites) — **450/0 after the post-gate fold (+2 tests)** |
| `forge build --sizes` LeashAccountV5 | ≤ 24,576 | **24,479 B (97 B headroom)** |
| `tsc --noEmit` (backend) | 0 | **0** |
| `eslint src test` | 0 | **0** |
| V5 unit suites (same-address, same-address-v5, v5-initcode) | 25/25 | **25 passed / 25** |

(signing-runtime-fp3 integration = 4 SKIPPED — needs hermetic Postgres/TI-1, per P1; unchanged, out of scope.)

## Mandatory re-verification — all PASS (firsthand code + empirical evidence)

1. **C-03 (no delegatecall) — PASS.** PUSH-aware opcode scan of the compiled `LeashAccountV5` runtime:
   **DELEGATECALL(0xf4)=0, CALLCODE(0xf2)=0**, STATICCALL(0xfa)=8, CALL(0xf1)=4. `test_C03_noDelegatecallOpcode`
   (`test/LeashAccountV5.inherited.t.sol:163`) asserts the same in the green 448. `SigningLib` is a `contract`
   (not a Solidity `library`); `reconstructAndBound`/`verifyCoSigner` are `pure` → the 8 STATICCALLs confirm the
   helper calls are static. **The docs' STATICCALL claim is accurate** (Solidity selects STATICCALL on the
   *callee's* `pure`/`view`, independent of the mutating caller — correcting a code-reviewer NIT to the contrary).

2. **SR-1 cross-chain / cross-account replay — PASS.** The co-signer signs
   `keccak256(abi.encode(COSIGNER_APPROVAL_TYPEHASH, intentDigest, chainId, account, epoch))`
   (SigningLib `verifyCoSigner`), with `chainId = block.chainid` and `account = address(this)` passed by the account
   (`LeashAccountV5.sol` arm call) — **not caller-supplied, not a raw-digest sig**. So even when a protocol's own
   EIP-712 domain omits `chainId`, the approval still fails-closed on chain B / a different account instance.
   `vm.chainId` replay test present and green.

3. **SR-3 epoch-bump re-arm — PASS.** Approval binds `signingEpoch`; `_bumpSigningEpoch` on add/apply. A stale
   (old-epoch) approval produces a different `approvalHash` → `BadCoSignerSignature` post-bump. No separate nonce:
   `AlreadyArmed` (live digest) + `DeadlineInPast` (expired, same-fields ⇒ same deadline) cover same-epoch reuse.

4. **SR-4 unconditional / SR-9 inert — PASS.** The co-signer check lives inside the single `reconstructAndBound`
   call, before the account's `AlreadyArmed`/allowlist/debit/arm-write — so it runs on EVERY arm (`amount==0`,
   nested, expiry-leaf). `if (coSigner != address(0) && !verifyCoSigner(...)) revert` short-circuits when
   `coSigner==0` — recover never called, `coSignerSig` ignored (inert).

5. **SR-6 / SR-7 authority — PASS.** `setCoSigner` + `applyCoSigner` are `onlyOwner`. ADD (`0→X`) = instant +
   epoch bump; REMOVE/SWAP = `pendingCoSigner`/`pendingCoSignerEta` + `applyCoSigner` (eta enforced). Guardian has
   no co-signer path (`onlyOwner`) and cannot arm (`authorizeSigningIntent` requires `msg.sender==sessionKey`).
   `revoke` → `_clearPendingTimelocks` → `_clearPendingCoSigner` cancels a pending weakening.

6. **SR-8 malleability — PASS.** Both factors use OZ `tryRecover` with the error CHECKED
   (`err == RecoverError.NoError`) → rejects high-S / bad-length / zero. No bare `recover`/`ecrecover`.

7. **`reconstructAndBound` fold — PASS (behavior-preserving + fail-closed).** All checks (digest reconstruct,
   both sig factors, canonical spender decode, cap/deadline/expiry bounds) are pure and precede ALL account state
   writes (`AlreadyArmed` read → allowlist read → budget debit → arm write) — SR-11 satisfied. The revert-ordering
   shift (session recover + bounds now BEFORE `AlreadyArmed`) changes **no success/fail outcome**, only the revert
   *reason* in the already-armed-with-bad-sig corner — both paths still revert, no state written. `SigningIntentPolicy`
   relocated to SigningLib with **verbatim field order** → identical storage layout for
   `mapping(uint256 => SigningLib.SigningIntentPolicy)`. The 448 forge (incl. signing invariants) prove digest/decode
   byte-identity.

8. **D-FP4-2f determinism hardening — PASS.** `foundry.toml` adds `bytecode_hash="none"` + `cbor_metadata=false`
   (only change) → pure, trailer-free bytecode. This is the sole cause of the address re-pin; untouched contracts'
   logic unchanged (V5 shrank to 24,479 B). Backend `v5-initcode.generated.ts` regenerated to the metadata-free
   creationCode; no stale/old addresses hard-coded in `abis.ts`/`session-chain.ts`. (RUN_DEPLOYED 4-chain same-address
   re-proof already green in RESULTS; not re-run here — adopts-existing, no new risk.)

9. **Backend 4-arg / inert default — PASS.** `abis.ts` `authorizeSigningIntent` is 4-arg; `session-chain.ts` arm
   passes `(input.coSignerSig ?? '0x')`. No account sets a co-signer today (D-FP4-2e defers orchestration to `#16`),
   so the inert path is exercised everywhere — safe.

## Findings (none blocking)

- **[FIXED — post-gate] `setCoSigner(cur)` same-value stages a spurious pending.** *(was LOW)* Both Sonnet agents
  flagged that re-asserting the current co-signer fell to the `else` branch, staging `pendingCoSigner=cur` + eta;
  if `applyCoSigner` was later called it bumped the epoch and emitted a misleading `CoSignerChanged(X,X)`.
  **Fix folded in (Dami ruled fold):** a guard at the top of `setCoSigner` — `if (next == cur) { _clearPendingCoSigner(); return; }`
  — makes same-value a true no-op (cancels any in-flight weakening, no epoch bump, no event). Matches the NatSpec
  intent that previously over-claimed. Size unchanged (24,479 B). +2 tests (`test_sameValue_isNoOp_doesNotStagePending`,
  `test_sameValue_cancelsPendingWeakening`) → **forge now 450/0**.
- **[LOW — `#16` scope] Backend callers lack `coSignerSig`.** `manager.ts` / `treasury-graph.ts` call the arm without
  the field (defaults `'0x'`). Safe today (inert path); must thread the real approval before the first account
  activates `setCoSigner` — already the `#16` orchestration task (D-FP4-2e).
- **[LOW — `#16` note] Approval is a raw structHash, no `0x1901` domain envelope** → not signable via
  `eth_signTypedData_v4` UI; co-signer must use raw signing. Security bindings are correct; note for `#16` key-mgmt.
- **[INFO] `BadCoSignerSignature` absent from `abis.ts` error list** — backend log-decoding ergonomics once active.
- **[NIT] `applyCoSigner` emits `CoSignerChanged` before the `coSigner = next` write** — safe, but inconsistent with
  `GuardianChanged`/`SessionKeyChanged` (effects-before-events). Cosmetic.

## Disposition
All 9 mandatory items PASS; reproductions green; two distinct-model Sonnet audits AGREE; no BLOCKER/HIGH. The
co-signer mechanism is sound and the fold is behavior-preserving. **AGREE** — commit Slice-2 (push held to end of
FP-4). Recommend the one 2-line `setCoSigner` same-value guard be folded into the FP-4 tail; the rest are `#16`
carries already recorded in D-FP4-2e. **Dami is the gate.**
