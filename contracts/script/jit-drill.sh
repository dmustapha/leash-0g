#!/usr/bin/env bash
# D-11 DEPLOYED JIT-RAIL DRILL — the Lane-2 grant PRIMITIVES proven on the LIVE 0G
# deployment. When a call is OUT of the standing envelope the owner's two JIT decisions land
# and make the retry succeed:
#   (1) APPROVE-ONCE  — owner authorizeOnce(callHash) → the exact over-cap call succeeds ONCE,
#                       then a replay reverts (consumed — not repeatable).
#   (2) ALWAYS-ALLOW  — owner proposeCallRule (loosen the cap) → applyCallRule → the
#                       previously-over-cap call now succeeds as a STANDING capability.
#
# SE-4: a baseline-reset preamble restores the canonical perCallCap (200e6) BEFORE the body,
# so the "over-cap reverts" preconditions hold on EVERY run even though this drill's own
# always-allow step loosens the cap to 400e6. Bounded RPC-flake retries; counts in evidence
# JSON, never a commit subject. timelockDelay=0 (drill) so a loosen applies immediately; on
# the real stack the owner waits the 15-min timelock. Writes docs/evidence/stage-d-jit-drill.json.
#
# NOTE (honest scope): proves the on-chain HALF of the JIT rail. The full backend-driven E2E
# (agent novel call → runtime raises a quarantined JIT request → owner approves → runtime
# retries) is the SE-2 one-shot-consume deployed drill (one-shot-consume-drill.ts) + its [CI]
# suite (7/7).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/drill-common.sh"

USD="$STACK_USD"; ROUTER="$STACK_ROUTER"
APPROVE="$SEL_APPROVE"
OVER_CAP=250000000       # over the canonical perCallCap (200e6)
STANDING=300000000       # over the OLD cap, within the LOOSENED cap
NEW_CAP=400000000        # loosened perCallCap
NEW_WINDOW=1000000000000 # loosened windowCapCall

echo "== Stage D deployed JIT-rail drill @ $A (stack=$STACK_NAME) =="
reset_baseline || { result_line; exit 1; }
echo "-- drill body --"

# ── (1) APPROVE-ONCE ─────────────────────────────────────────────────────────
OVERDATA=$(cast calldata "approve(address,uint256)" "$ROUTER" "$OVER_CAP")
expect_revert "precondition: over-cap approve(router,250e6) out-of-envelope" "$OVERDATA" "0x2671b8a6" "$USD"

# Owner reviews + authorizes THIS EXACT call once. callHash = keccak256(abi.encode(target,selector,data,value)).
CALLHASH=$(cast keccak "$(cast abi-encode 'f(address,bytes4,bytes,uint256)' "$USD" "$APPROVE" "$OVERDATA" 0)")
EXPIRY=$(( $(date +%s) + 3600 ))
send_confirmed "$A" "authorizeOnce(bytes32,uint64)" "$CALLHASH" "$EXPIRY" >/dev/null || _flake "authorizeOnce submit exhausted"
note "owner authorizeOnce($CALLHASH, expiry=$EXPIRY)"

# The retry now SUCCEEDS once (allowance moves to OVER_CAP).
ONCE_TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$OVERDATA" || true)
wait_status "$ONCE_TX" >/dev/null || true
ALLOW1=$(num_read "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER")
if [ "$ALLOW1" = "$OVER_CAP" ]; then _pass "approve-once retry landed tx=$ONCE_TX allowance=$ALLOW1"
elif [ -z "$ALLOW1" ]; then _flake "approve-once allowance read exhausted"
else _fail "approve-once allowance=$ALLOW1 (want $OVER_CAP)"; fi

# A replay of the consumed one-shot reverts (consumed → falls through to standing envelope →
# OverPerCallCap): the one-shot is NOT repeatable.
expect_revert "one-shot replay refused (consumed)" "$OVERDATA" "0x2671b8a6" "$USD"

# ── (2) ALWAYS-ALLOW (loosen the standing rule) ──────────────────────────────
STANDDATA=$(cast calldata "approve(address,uint256)" "$ROUTER" "$STANDING")
expect_revert "precondition: standing approve(router,300e6) exceeds old cap" "$STANDDATA" "0x2671b8a6" "$USD"

# Owner grants the wider envelope (loosen perCallCap 200e6→400e6). Reset restores 200e6 next run.
send_confirmed "$A" "proposeCallRule(address,bytes4,uint8,address[],uint128,uint128,bytes32)" \
  "$USD" "$APPROVE" 0 "[$ROUTER]" "$NEW_CAP" "$NEW_WINDOW" "$BASE_CODEHASH" >/dev/null || _flake "proposeCallRule submit exhausted"
send_confirmed "$A" "applyCallRule()" >/dev/null || _flake "applyCallRule submit exhausted"
note "owner proposeCallRule(loosen cap→400e6) + applyCallRule"

# The standing retry now SUCCEEDS within the widened envelope.
STAND_TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$STANDDATA" || true)
wait_status "$STAND_TX" >/dev/null || true
ALLOW2=$(num_read "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER")
if [ "$ALLOW2" = "$STANDING" ]; then _pass "always-allow standing retry landed tx=$STAND_TX allowance=$ALLOW2"
elif [ -z "$ALLOW2" ]; then _flake "always-allow allowance read exhausted"
else _fail "always-allow allowance=$ALLOW2 (want $STANDING)"; fi

result_line
mkdir -p ~/leash/docs/evidence
EVID=~/leash/docs/evidence/stage-d-jit-drill.json
# SE-5.0 (evidence-honesty nit): a single overwritten resetProof hides the run that
# actually restores from a loosened cap (a run starting already-canonical shows
# before==after==200e6, never the narrated 400e6→200e6). Carry a per-run history so
# BOTH back-to-back SE-4 runs' reset proofs are individually inspectable: read the
# prior file's runs (or fold its single resetProof forward), append THIS run, keep
# the last two. Run 1 records its reset; run 2 records the 400e6→200e6 restore.
PRIOR_RUNS='[]'
if [ -f "$EVID" ]; then
  PRIOR_RUNS=$(jq -c '.resetRuns // (if .resetProof then [.resetProof] else [] end)' "$EVID" 2>/dev/null || echo '[]')
fi
RESET_RUNS=$(jq -c --arg b "$RESET_BEFORE" --arg a "$RESET_AFTER" --arg c "$BASE_PER_CALL_CAP" \
  '. + [{approvePerCallCapBefore:$b, approvePerCallCapAfter:$a, canonical:$c}] | .[-2:]' <<<"$PRIOR_RUNS")
cat > "$EVID" <<JSON
{
  "phase": "Stage D — governed calldata (SE-4 idempotent re-run)",
  "kind": "deployed JIT-rail drill (D-11, on-chain grant primitives)",
  "stack": "$STACK_NAME",
  "chainId": $STACK_CHAIN_ID,
  "account": "$A",
  "resetProof": { "approvePerCallCapBefore": "$RESET_BEFORE", "approvePerCallCapAfter": "$RESET_AFTER", "canonical": "$BASE_PER_CALL_CAP" },
  "resetRuns": $RESET_RUNS,
  "approveOnce": { "callHash": "$CALLHASH", "retryTx": "$ONCE_TX", "allowanceAfter": "$ALLOW1", "replayRefused": true },
  "alwaysAllow": { "loosenedPerCallCap": "$NEW_CAP", "loosenedWindowCap": "$NEW_WINDOW", "retryTx": "$STAND_TX", "allowanceAfter": "$ALLOW2" },
  "checks": { "passed": $pass, "failed": $fail, "flaked": $flake },
  "note": "On-chain half of the JIT rail; full backend-driven E2E = the SE-2 one-shot-consume deployed drill + its [CI] 7/7."
}
JSON
echo "evidence → docs/evidence/stage-d-jit-drill.json"
drill_green
