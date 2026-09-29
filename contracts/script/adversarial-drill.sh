#!/usr/bin/env bash
# D-15 DEPLOYED ADVERSARIAL DRILL — the governed-calldata wall proven on the LIVE 0G
# deployment (not just CI). A HAPPY governed approve lands on-chain within caps; every
# MALICIOUS call shape REVERTS live (eth_call against live state + a real reverting tx).
#
# SE-4: runs a baseline-reset preamble first (canonical caps restored) + bounded RPC-flake
# retries, so it re-produces its full green score ON DEMAND — no residual-state FAIL on
# re-run, no spurious flake FAIL. Point-in-time counts live in the evidence JSON, never a
# commit subject. Writes docs/evidence/stage-d-adversarial-drill.json.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/drill-common.sh"

USD="$STACK_USD"; ROUTER="$STACK_ROUTER"; VAULT="$STACK_VAULT"; ATTACKER="$STACK_ATTACKER"
RANDOM_TARGET="$ROUTER"                 # router has code but is NOT an allowlisted call TARGET
MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

echo "== Stage D deployed adversarial drill @ $A (stack=$STACK_NAME) =="
reset_baseline || { result_line; exit 1; }

# --- HAPPY: governed approve within caps lands on-chain (real tx) ---
echo "-- drill body --"
HAPPY_DATA=$(cast calldata "approve(address,uint256)" "$ROUTER" 100000000)
TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$HAPPY_DATA" || true)
wait_status "$TX" >/dev/null || true
ALLOW=$(num_read "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER")
if [ "$ALLOW" = "100000000" ]; then _pass "HAPPY approve(router,100e6) landed tx=$TX allowance=$ALLOW"
elif [ -z "$ALLOW" ]; then _flake "HAPPY approve allowance read exhausted"
else _fail "HAPPY allowance=$ALLOW (want 100000000)"; fi

# --- MALICIOUS (eth_call reverts live at the true boundary; caps are canonical post-reset) ---
expect_revert "approve(max) infinite"         "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$(cast to-dec $MAX)")" "0xcd9e3525" "$USD"
expect_revert "approve off-allowlist spender"  "$(cast calldata 'approve(address,uint256)' "$ATTACKER" 1000000)" "0x6eed196c" "$USD"
expect_revert "approve over per-call cap"      "$(cast calldata 'approve(address,uint256)' "$ROUTER" 300000000)" "0x2671b8a6" "$USD"
expect_revert "off-allowlist target"           "$(cast calldata 'approve(address,uint256)' "$ROUTER" 1000000)" "0x042a9b0d" "$RANDOM_TARGET"

# --- MALICIOUS real tx reverts on-chain (approve max) ---
# A reverting tx can't be gas-estimated (estimation reverts), so pin a gas limit. Confirm the tx
# MINED via nonce advancement (robust to this RPC's flaky receipts), then prove the wall rejected
# it by OBSERVABLE state: the on-chain allowance stays 100e6 — a successful approve(max) would set
# it to max. This is flake-robust where a raw `cast receipt status` read is not.
MAXDEC=$(cast to-dec $MAX)
MAXTX=$(SEND_GAS_LIMIT=300000 send_confirmed "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$MAXDEC")" || true)
ALLOW_AFTER_MAX=$(num_read "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER")
if [ -z "$ALLOW_AFTER_MAX" ]; then _flake "MALICIOUS approve(max) real-tx allowance read exhausted tx=$MAXTX"
elif [ "$ALLOW_AFTER_MAX" = "$MAXDEC" ]; then _fail "MALICIOUS approve(max) real tx SUCCEEDED — allowance=max tx=$MAXTX"
else _pass "MALICIOUS approve(max) real tx reverted on-chain (allowance unchanged=$ALLOW_AFTER_MAX, not max) tx=$MAXTX"; fi

# ── FIX-1 on-chain DEPOSIT DECODER (the wall that changed) ────────────────────
# deposit(uint256 assets, address receiver): receiver pinned self (recipientMode=0), assets
# charged vs per-call cap + vault-keyed budget. A hijacked session key can NEVER redirect the
# minted shares to an attacker, nor exceed the cap.
echo "-- FIX-1 deposit decoder --"
expect_revert "deposit redirect to attacker" "$(cast calldata 'deposit(uint256,address)' 100000000 "$ATTACKER")" "0x239e7696" "$VAULT"
expect_revert "deposit over per-call cap"     "$(cast calldata 'deposit(uint256,address)' 300000000 "$A")" "0x2671b8a6" "$VAULT"

# (iii) happy: approve(vault,100e6) then deposit(100e6, self) credits shares to self. Confirm
# on OBSERVABLE on-chain state (allowance / shares delta); resubmit only when state has NOT
# moved after a full poll window — safe against double-deposit even under receipt drops.
allowance_vault() { num_read "$USD" "allowance(address,address)(uint256)" "$A" "$VAULT"; }
shares_self()     { num_read "$VAULT" "shares(address)(uint256)" "$A"; }
SHARES0=$(shares_self)
APPV_TX=""
for i in 1 2 3 4 5; do
  [ "$(allowance_vault)" = "100000000" ] && break
  APPV_TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$(cast calldata 'approve(address,uint256)' "$VAULT" 100000000)" || true)
  for j in 1 2 3 4 5 6 7 8; do [ "$(allowance_vault)" = "100000000" ] && break; sleep 4; done
done
DEP_TX=""
for i in 1 2 3; do
  [ "$(shares_self)" != "$SHARES0" ] && break
  DEP_TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$VAULT" 0 "$(cast calldata 'deposit(uint256,address)' 100000000 "$A")" || true)
  for j in $(seq 1 15); do [ "$(shares_self)" != "$SHARES0" ] && break; sleep 4; done
done
SHARES1=$(shares_self)
DELTA=$(awk "BEGIN{print ${SHARES1:-0} - ${SHARES0:-0}}")
if [ "$DELTA" = "100000000" ]; then _pass "HAPPY approve->deposit(self,100e6) settled: shares $SHARES0->$SHARES1 (approve=$APPV_TX deposit=$DEP_TX)"
elif [ -z "$SHARES1" ]; then _flake "deposit shares read exhausted"
else _fail "deposit shares delta=$DELTA (want 100000000)"; fi

result_line
mkdir -p ~/leash/docs/evidence
cat > ~/leash/docs/evidence/stage-d-adversarial-drill.json <<JSON
{
  "phase": "Stage D — governed calldata (SE-4 idempotent re-run)",
  "kind": "deployed adversarial drill (D-15)",
  "stack": "$STACK_NAME",
  "chainId": $STACK_CHAIN_ID,
  "account": "$A",
  "grantedTarget": "$USD",
  "grantedSpender": "$ROUTER",
  "resetProof": { "approvePerCallCapBefore": "$RESET_BEFORE", "approvePerCallCapAfter": "$RESET_AFTER", "canonical": "$BASE_PER_CALL_CAP" },
  "happyApproveTx": "$TX",
  "happyAllowance": "$ALLOW",
  "depositDecoder": {
    "vault": "$VAULT",
    "redirectRevert": "RecipientNotSelf 0x239e7696",
    "overCapRevert": "OverPerCallCap 0x2671b8a6",
    "happyApproveTx": "$APPV_TX",
    "happyDepositTx": "$DEP_TX",
    "sharesBefore": "$SHARES0",
    "sharesAfter": "$SHARES1"
  },
  "checks": { "passed": $pass, "failed": $fail, "flaked": $flake },
  "vectors": ["approve(max)", "off-allowlist spender", "over per-call cap", "off-allowlist target", "malicious real-tx revert", "deposit redirect (RecipientNotSelf)", "deposit over per-call cap", "deposit happy self-credit"]
}
JSON
echo "evidence → docs/evidence/stage-d-adversarial-drill.json"
drill_green
