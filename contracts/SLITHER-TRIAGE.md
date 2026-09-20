# Slither triage — Phase 1 (2026-09-20)

`slither . --filter-paths "lib/"` → 9 results, 0 high/medium. Disposition:

| Detector | Finding | Disposition |
|---|---|---|
| `missing-zero-check` | `guardian_` in constructor / `setGuardian(g)` | **Intentional.** `address(0)` guardian = "no guardian" (owner-removable role, spec §3a H-02). Zero is a valid state; revoke still works via owner. |
| `timestamp` (×5) | expiry / window rollover / timelock eta comparisons | **Accepted.** Miner drift on 0G (sub-second finality) is seconds-scale; policy windows and timelock delays are minutes-to-hours. Timestamp use is the design (velocity caps + timelocks require time). |
| `low-level-calls` (×2) | `to.call{value}()` in `execute` / `applyWithdraw` | **Intentional.** Native transfers to arbitrary allowlisted recipients require `.call`; success is checked (`CallFailed`), state updated CEI-before-call, `nonReentrant` on both. |
| `immutable-states` | `owner` could be immutable | **Fixed** — `owner` is now `immutable` (no ownership transfer in Phase 1). |

`--fail-medium` gate runs in CI; any new medium+ finding fails the build.
