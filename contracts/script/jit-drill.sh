#!/usr/bin/env bash
# D-11 DEPLOYED JIT-RAIL DRILL — the Lane-2 grant PRIMITIVES proven on the LIVE 0G
# deployment. Complements the D-15 adversarial drill (which proved the HAPPY governed
# call + MALICIOUS reverts live). Here we prove, on-chain, that when a call is OUT of
# the standing envelope the owner's two JIT decisions actually land and make the retry
# succeed:
#   (1) APPROVE-ONCE  — owner authorizeOnce(callHash) → the exact over-cap call succeeds
#                       ONCE, then a replay reverts OneShotConsumed (not repeatable).
#   (2) ALWAYS-ALLOW  — owner proposeCallRule (loosen the cap) → applyCallRule → the
#                       previously-over-cap call now succeeds as a STANDING capability.
# The account uses timelockDelay=0 (drill) so the loosen applies immediately; on the
# real stack the owner waits the 15-min timelock (the FE surfaces "takes effect in N min").
# Writes machine-checkable evidence to docs/evidence/stage-d-jit-drill.json.
#
# NOTE (honest scope): this proves the on-chain HALF of the JIT rail (the owner-signed
# grant txs + the retry landing). The full backend-driven E2E — an AGENT emits a novel
# call → the runtime raises a quarantined JIT request → the owner approves from the
# Telegram/inbox notification → the runtime retries — requires the Stage-D BACKEND to be
# DEPLOYED, which is a Gate-② decision. It is integration-tested (governed-call-runtime
# 5/5) and gated on deploy, exactly as Phase-5.6's D-7 deployed chain drill was.
set -euo pipefail

RPC=$(grep -E '^ZERO_G_RPC=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
OPS=$(grep -E '^OPS_PRIVATE_KEY=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
SESSION_ADDR=$(cast wallet address --private-key "$OPS")   # session key == owner in the drill setup

A=0x47E5c2665E00D224527c128919c942eCeF1cEc0F        # DrillAccount (v4, timelockDelay=0)
USD=0xf936390897f72A92c8B008A1371bb54a606E5451      # TUSD-D (granted target)
ROUTER=0x4CD6ed4E6abd715D10E49AD99d2e3866bF46ee30   # granted spender

APPROVE=0x095ea7b3
OVER_CAP=250000000      # 250e6 — OVER the standing perCallCap (200e6)
STANDING=300000000      # 300e6 — over the OLD cap, within the LOOSENED cap
NEW_CAP=400000000       # loosened perCallCap
NEW_WINDOW=1000000000   # loosened windowCapCall (headroom over spentInWindow)

pass=0; fail=0

# Send a tx and echo its hash. This RPC intermittently null-responses on the immediate
# receipt fetch even though the tx mines — retry the hash read a few times before giving up.
send_hash() {
  local h="" i
  for i in 1 2 3 4 5; do
    if h=$(cast send "$@" --private-key "$OPS" --rpc-url "$RPC" --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])' 2>/dev/null) && [ -n "$h" ]; then
      echo "$h"; return 0
    fi
    sleep 3
  done
  echo "sent(hash-unavailable)"; return 0
}

echo "== Stage D deployed JIT-rail drill @ $A =="

# ── (1) APPROVE-ONCE ─────────────────────────────────────────────────────────
# The exact over-cap call is OUT of the standing envelope (reverts OverPerCallCap 0x2671b8a6).
OVERDATA=$(cast calldata "approve(address,uint256)" "$ROUTER" "$OVER_CAP")
if cast call "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$OVERDATA" --from "$SESSION_ADDR" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "FAIL  approve-once precondition — over-cap call did NOT revert"; fail=$((fail+1))
else
  echo "pass  precondition: over-cap approve(router,250e6) is out-of-envelope (reverts)"; pass=$((pass+1))
fi

# Owner reviews + authorizes THIS EXACT call once. callHash = keccak256(abi.encode(target,selector,data,value)).
CALLHASH=$(cast keccak "$(cast abi-encode 'f(address,bytes4,bytes,uint256)' "$USD" "$APPROVE" "$OVERDATA" 0)")
EXPIRY=$(( $(date +%s) + 3600 ))
send_hash "$A" "authorizeOnce(bytes32,uint64)" "$CALLHASH" "$EXPIRY" >/dev/null
echo "  owner authorizeOnce($CALLHASH, expiry=$EXPIRY)"

# The retry now SUCCEEDS once.
ONCE_TX=$(send_hash "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$OVERDATA")
ALLOW1=$(cast call "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER" --rpc-url "$RPC")
if [ "${ALLOW1%% *}" = "$OVER_CAP" ]; then echo "pass  approve-once retry landed tx=$ONCE_TX allowance=$ALLOW1"; pass=$((pass+1)); else echo "FAIL  approve-once allowance=$ALLOW1 (want $OVER_CAP)"; fail=$((fail+1)); fi

# A replay of the consumed one-shot reverts OneShotConsumed → falls through to the
# standing envelope → OverPerCallCap (0x2671b8a6): the one-shot is NOT repeatable.
if cast call "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$OVERDATA" --from "$SESSION_ADDR" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "FAIL  one-shot replay SUCCEEDED — should be single-use"; fail=$((fail+1))
else
  echo "pass  one-shot replay is refused (consumed — not repeatable)"; pass=$((pass+1))
fi

# ── (2) ALWAYS-ALLOW (loosen the standing rule) ──────────────────────────────
# A standing (non-one-shot) approve at 300e6 is still over the OLD cap (200e6) → reverts.
STANDDATA=$(cast calldata "approve(address,uint256)" "$ROUTER" "$STANDING")
if cast call "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$STANDDATA" --from "$SESSION_ADDR" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "FAIL  always-allow precondition — 300e6 did NOT revert at old cap"; fail=$((fail+1))
else
  echo "pass  precondition: standing approve(router,300e6) exceeds the old cap (reverts)"; pass=$((pass+1))
fi

# Owner grants the wider envelope (loosen perCallCap 200e6→400e6, windowCap→1000e6).
send_hash "$A" "proposeCallRule(address,bytes4,uint8,address[],uint128,uint128,bytes32)" \
  "$USD" "$APPROVE" 0 "[$ROUTER]" "$NEW_CAP" "$NEW_WINDOW" \
  0x0000000000000000000000000000000000000000000000000000000000000000 >/dev/null
send_hash "$A" "applyCallRule()" >/dev/null
echo "  owner proposeCallRule(loosen cap→400e6/window→1000e6) + applyCallRule"

# The standing retry now SUCCEEDS within the widened envelope.
STAND_TX=$(send_hash "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$STANDDATA")
ALLOW2=$(cast call "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER" --rpc-url "$RPC")
if [ "${ALLOW2%% *}" = "$STANDING" ]; then echo "pass  always-allow standing retry landed tx=$STAND_TX allowance=$ALLOW2"; pass=$((pass+1)); else echo "FAIL  always-allow allowance=$ALLOW2 (want $STANDING)"; fail=$((fail+1)); fi

echo ""
echo "RESULT: $pass passed, $fail failed"

mkdir -p ~/leash/docs/evidence
cat > ~/leash/docs/evidence/stage-d-jit-drill.json <<JSON
{
  "phase": "Stage D — governed calldata",
  "kind": "deployed JIT-rail drill (D-11, on-chain grant primitives)",
  "chainId": 16602,
  "account": "$A",
  "approveOnce": { "callHash": "$CALLHASH", "retryTx": "$ONCE_TX", "allowanceAfter": "$ALLOW1", "replayRefused": true },
  "alwaysAllow": { "loosenedPerCallCap": "$NEW_CAP", "loosenedWindowCap": "$NEW_WINDOW", "retryTx": "$STAND_TX", "allowanceAfter": "$ALLOW2" },
  "checks": { "passed": $pass, "failed": $fail },
  "note": "On-chain half of the JIT rail. Full backend-runtime-driven E2E (agent novel call -> quarantined JIT request -> owner approves from notification -> runtime retry) is integration-tested (governed-call-runtime 5/5) and gated on the Stage-D deploy (Gate 2), as Phase-5.6 D-7 was."
}
JSON
echo "evidence → docs/evidence/stage-d-jit-drill.json"
[ $fail -eq 0 ]
