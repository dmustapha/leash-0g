# Slither triage — Phase 1 (2026-09-20)

`slither . --filter-paths "lib/"` → 9 results, 0 high/medium. Disposition:

| Detector | Finding | Disposition |
|---|---|---|
| `missing-zero-check` | `guardian_` in constructor / `setGuardian(g)` | **Intentional.** `address(0)` guardian = "no guardian" (owner-removable role, spec §3a H-02). Zero is a valid state; revoke still works via owner. |
| `timestamp` (×5) | expiry / window rollover / timelock eta comparisons | **Accepted.** Miner drift on 0G (sub-second finality) is seconds-scale; policy windows and timelock delays are minutes-to-hours. Timestamp use is the design (velocity caps + timelocks require time). |
| `low-level-calls` (×2) | `to.call{value}()` in `execute` / `applyWithdraw` | **Intentional.** Native transfers to arbitrary allowlisted recipients require `.call`; success is checked (`CallFailed`), state updated CEI-before-call, `nonReentrant` on both. |
| `immutable-states` | `owner` could be immutable | **Fixed** — `owner` is now `immutable` (no ownership transfer in Phase 1). |

`--fail-medium` gate runs in CI; any new medium+ finding fails the build.

---

# Slither triage — Phase 4 (v3 token path, 2026-09-22)

`slither . --filter-paths "lib/" --fail-medium` → **13 results, 0 high/medium (exit 0)**. New/changed dispositions for the ERC-20 settlement path (`executeTokenTransfer`, `MockERC20`, factory/constructor v3):

| Detector | Finding | Disposition |
|---|---|---|
| `missing-zero-check` | `settlementToken_` in constructor lacks a zero-check | **Intentional.** `address(0)` = a NATIVE-ONLY account (every legacy v2 account + every provider/evaluator). Zero is a valid, load-bearing state; `executeTokenTransfer` reverts `NoSettlementToken` when unset. Same rationale as the `guardian` zero-check. |
| `timestamp` | `executeTokenTransfer` expiry + token-window rollover; `applyTokenPolicy` eta | **Accepted.** Identical to the native `execute`/`applyPolicy` rationale — velocity caps + timelocks require `block.timestamp`; 0G miner drift (sub-second finality) is negligible vs minute-to-hour windows. |
| `cyclomatic-complexity` | `executeTokenTransfer` complexity 12 (informational) | **Accepted.** The function is a linear leash-check sequence (session-key → revoke → expiry → zero → token match → recipient allowlist → per-transfer cap → tumbling window → CEI → guarded call). Splitting it would scatter the audit-critical ordering; kept as one readable, auditable path mirroring `execute`. |
| `low-level-calls` | `token.call(abi.encodeCall(IERC20.transfer, ...))` in `executeTokenTransfer` | **Intentional.** The account BUILDS the calldata (agent supplies none — D-JOB-6); a raw `.call` with a SafeERC20-style return check (`ok && (no returndata \|\| decoded true)`) is required to support non-standard (no-return) ERC-20s while catching false-return/reverting tokens. CEI (account before call) + `nonReentrant` on the function. |

No new reentrancy, arbitrary-send, or unchecked-transfer findings. `--fail-medium` gate stays green.
