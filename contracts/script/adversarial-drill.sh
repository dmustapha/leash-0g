#!/usr/bin/env bash
# D-15 DEPLOYED ADVERSARIAL DRILL — the governed-calldata wall proven on the LIVE 0G
# deployment (not just CI). A HAPPY governed approve lands on-chain within caps; every
# MALICIOUS call shape REVERTS live (eth_call against live state + a real reverting tx).
# Writes machine-checkable evidence to docs/evidence/stage-d-adversarial-drill.json.
set -euo pipefail

RPC=$(grep -E '^ZERO_G_RPC=' ~/leash/backend/.env | cut -d= -f2-)
OPS=$(grep -E '^OPS_PRIVATE_KEY=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
SESSION_ADDR=$(cast wallet address --private-key "$OPS")

A=0x47E5c2665E00D224527c128919c942eCeF1cEc0F        # DrillAccount (v4)
USD=0xf936390897f72A92c8B008A1371bb54a606E5451      # TUSD-D (granted target)
ROUTER=0x4CD6ed4E6abd715D10E49AD99d2e3866bF46ee30   # granted spender
ATTACKER=0x000000000000000000000000000000000000dEaD
RANDOM_TARGET=0xf951F8655C0a549c6187aB4b6Aec9fE76E402e2d # MockVault — NOT allowlisted

APPROVE=0x095ea7b3
MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

pass=0; fail=0
note() { echo "  $1"; }

# expect an eth_call (from session) to REVERT with a given 4-byte selector substring
expect_revert() {
  local label="$1" data="$2" want="$3"
  local out
  if out=$(cast call "$A" "executeCall(address,uint256,bytes)" "$4" 0 "$data" --from "$SESSION_ADDR" --rpc-url "$RPC" 2>&1); then
    echo "FAIL  $label — call SUCCEEDED, expected revert"; fail=$((fail+1)); return
  fi
  if echo "$out" | grep -qiE "$want"; then
    echo "pass  $label → reverted with $want"; pass=$((pass+1))
  else
    echo "FAIL  $label — reverted but not with $want: $out"; fail=$((fail+1))
  fi
}

echo "== Stage D deployed adversarial drill @ $A =="

# --- HAPPY: governed approve within caps lands on-chain (real tx) ---
HAPPY_DATA=$(cast calldata "approve(address,uint256)" "$ROUTER" 100000000)
TX=$(cast send "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$HAPPY_DATA" --private-key "$OPS" --rpc-url "$RPC" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
ALLOW=$(cast call "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER" --rpc-url "$RPC")
if [ "${ALLOW%% *}" = "100000000" ]; then echo "pass  HAPPY approve(router,100e6) landed tx=$TX allowance=$ALLOW"; pass=$((pass+1)); else echo "FAIL  HAPPY allowance=$ALLOW"; fail=$((fail+1)); fi

# --- MALICIOUS (eth_call reverts live) ---
expect_revert "approve(max) infinite"        "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$(cast to-dec $MAX)")" "0xcd9e3525" "$USD"
expect_revert "approve off-allowlist spender" "$(cast calldata 'approve(address,uint256)' "$ATTACKER" 1000000)" "0x6eed196c" "$USD"
expect_revert "approve over per-call cap"     "$(cast calldata 'approve(address,uint256)' "$ROUTER" 300000000)" "0x2671b8a6" "$USD"
expect_revert "off-allowlist target"          "$(cast calldata 'approve(address,uint256)' "$ROUTER" 1000000)" "0x042a9b0d" "$RANDOM_TARGET"

# --- MALICIOUS real tx reverts on-chain (approve max) ---
set +e
RAWOUT=$(cast send "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$(cast to-dec $MAX)")" --private-key "$OPS" --rpc-url "$RPC" 2>&1)
RC=$?
set -e
if [ $RC -ne 0 ]; then echo "pass  MALICIOUS approve(max) real tx reverted on-chain"; pass=$((pass+1)); else echo "FAIL  MALICIOUS approve(max) real tx did NOT revert"; fail=$((fail+1)); fi

echo ""
echo "RESULT: $pass passed, $fail failed"

mkdir -p ~/leash/docs/evidence
cat > ~/leash/docs/evidence/stage-d-adversarial-drill.json <<JSON
{
  "phase": "Stage D — governed calldata",
  "kind": "deployed adversarial drill (D-15)",
  "chainId": 16602,
  "account": "$A",
  "grantedTarget": "$USD",
  "grantedSpender": "$ROUTER",
  "happyApproveTx": "$TX",
  "happyAllowance": "$ALLOW",
  "checks": { "passed": $pass, "failed": $fail },
  "vectors": ["approve(max)", "off-allowlist spender", "over per-call cap", "off-allowlist target", "malicious real-tx revert"]
}
JSON
echo "evidence → docs/evidence/stage-d-adversarial-drill.json"
[ $fail -eq 0 ]
