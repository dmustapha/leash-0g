#!/usr/bin/env bash
# D-15 DEPLOYED ADVERSARIAL DRILL — the governed-calldata wall proven on the LIVE 0G
# deployment (not just CI). A HAPPY governed approve lands on-chain within caps; every
# MALICIOUS call shape REVERTS live (eth_call against live state + a real reverting tx).
# Writes machine-checkable evidence to docs/evidence/stage-d-adversarial-drill.json.
set -euo pipefail

RPC=$(grep -E '^ZERO_G_RPC=' ~/leash/backend/.env | cut -d= -f2-)
OPS=$(grep -E '^OPS_PRIVATE_KEY=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
SESSION_ADDR=$(cast wallet address --private-key "$OPS")

# cfabfdb (post-FIX-1) redeploy on 0G 16602 — Stage-D DEPLOY (2026-09-28).
A=0x2FDbfa0e76D4dC455C95C4e7d445595E714cDCDF        # DrillAccount (v4, fixed bytecode)
USD=0x4E51f90C8Cf60307E01A6abF555762e69Ef0eC2A      # TUSD-D (granted target)
ROUTER=0x425B8638e1B851486F397715EA414d52A1Ab7a65   # granted approve spender (also serves as a NON-allowlisted-target probe)
VAULT=0x6F370dd513bF45D69178cb2E1BEe2BF15bAFCE87     # MockVault — granted deposit target (recipientMode=self)
ATTACKER=0x000000000000000000000000000000000000dEaD
RANDOM_TARGET=$ROUTER                                # router has code but is NOT an allowlisted call TARGET

APPROVE=0x095ea7b3
DEPOSIT=0x6e553f65
MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

pass=0; fail=0
note() { echo "  $1"; }

# This RPC intermittently null-responses on the synchronous receipt fetch even though the
# tx mines. Submit with --async (returns the hash immediately, no receipt wait) then poll
# the receipt separately — avoids the duplicate-send a blind cast-send retry would cause.
send_async() { cast send "$@" --private-key "$OPS" --rpc-url "$RPC" --async 2>/dev/null; }
wait_status() { # $1 = tx hash → echoes receipt status (1 success / 0 revert), retrying
  local h="$1" i st
  for i in $(seq 1 30); do
    st=$(cast receipt "$h" status --rpc-url "$RPC" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$st" ]; then echo "$st"; return 0; fi
    sleep 4
  done
  echo ""; return 1
}

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
TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$HAPPY_DATA" || true)
wait_status "$TX" >/dev/null || true
ALLOW=$(cast call "$USD" "allowance(address,address)(uint256)" "$A" "$ROUTER" --rpc-url "$RPC" | awk '{print $1}')
if [ "$ALLOW" = "100000000" ]; then echo "pass  HAPPY approve(router,100e6) landed tx=$TX allowance=$ALLOW"; pass=$((pass+1)); else echo "FAIL  HAPPY allowance=$ALLOW"; fail=$((fail+1)); fi

# --- MALICIOUS (eth_call reverts live) ---
expect_revert "approve(max) infinite"        "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$(cast to-dec $MAX)")" "0xcd9e3525" "$USD"
expect_revert "approve off-allowlist spender" "$(cast calldata 'approve(address,uint256)' "$ATTACKER" 1000000)" "0x6eed196c" "$USD"
expect_revert "approve over per-call cap"     "$(cast calldata 'approve(address,uint256)' "$ROUTER" 300000000)" "0x2671b8a6" "$USD"
expect_revert "off-allowlist target"          "$(cast calldata 'approve(address,uint256)' "$ROUTER" 1000000)" "0x042a9b0d" "$RANDOM_TARGET"

# --- MALICIOUS real tx reverts on-chain (approve max) ---
# --async so the submit doesn't revert client-side; assert the on-chain receipt status==0.
MAXTX=$(cast send "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$(cast to-dec $MAX)")" --private-key "$OPS" --rpc-url "$RPC" --async --gas-limit 300000 2>/dev/null || true)
MAXST=$(wait_status "$MAXTX" || true)
if [ "${MAXST:0:1}" = "0" ]; then echo "pass  MALICIOUS approve(max) real tx reverted on-chain (status=0) tx=$MAXTX"; pass=$((pass+1)); else echo "FAIL  MALICIOUS approve(max) real tx status=$MAXST (want 0) tx=$MAXTX"; fail=$((fail+1)); fi

# ── FIX-1 on-chain DEPOSIT DECODER (the wall that changed) ────────────────────
# deposit(uint256 assets, address receiver): the receiver is pinned self (recipientMode=0)
# and assets is charged vs the per-call cap + vault-keyed budget. A hijacked session key
# can NEVER redirect the minted shares to an attacker, nor exceed the cap.
echo ""
echo "-- FIX-1 deposit decoder --"
# (i) redirect: deposit(100e6, ATTACKER) → RecipientNotSelf (0x239e7696)
expect_revert "deposit redirect to attacker" "$(cast calldata 'deposit(uint256,address)' 100000000 "$ATTACKER")" "0x239e7696" "$VAULT"
# (ii) over per-call cap: deposit(300e6, self) → OverPerCallCap (0x2671b8a6)
expect_revert "deposit over per-call cap"     "$(cast calldata 'deposit(uint256,address)' 300000000 "$A")" "0x2671b8a6" "$VAULT"
# (iii) happy: approve(vault,100e6) then deposit(100e6, self) settles + credits shares to self.
# The 0G RPC intermittently drops the --async response even when the submit reaches the
# mempool, so we confirm on OBSERVABLE on-chain state (allowance / shares delta) and only
# resubmit when the state has NOT moved after a full poll window — safe against double-deposit.
# read until a numeric value comes back (the RPC intermittently returns empty)
num_read() { local v i; for i in $(seq 1 10); do v=$(cast call "$@" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'); case "$v" in ''|*[!0-9]*) ;; *) echo "$v"; return 0;; esac; sleep 2; done; echo 0; }
allowance_vault() { num_read "$USD" "allowance(address,address)(uint256)" "$A" "$VAULT"; }
shares_self()     { num_read "$VAULT" "shares(address)(uint256)" "$A"; }

SHARES0=$(shares_self)
# approve(vault,100e6) — idempotent (overwrites), resubmit-safe until allowance==100e6
APPV_TX=""
for i in 1 2 3 4 5; do
  [ "$(allowance_vault)" = "100000000" ] && break
  APPV_TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$USD" 0 "$(cast calldata 'approve(address,uint256)' "$VAULT" 100000000)" || true)
  for j in 1 2 3 4 5 6 7 8; do [ "$(allowance_vault)" = "100000000" ] && break; sleep 4; done
done
# deposit(100e6, self) — resubmit ONLY if shares haven't advanced after a full poll window
DEP_TX=""
for i in 1 2 3; do
  [ "$(shares_self)" != "$SHARES0" ] && break
  DEP_TX=$(send_async "$A" "executeCall(address,uint256,bytes)" "$VAULT" 0 "$(cast calldata 'deposit(uint256,address)' 100000000 "$A")" || true)
  for j in $(seq 1 15); do [ "$(shares_self)" != "$SHARES0" ] && break; sleep 4; done
done
SHARES1=$(shares_self)
DELTA=$(awk "BEGIN{print ${SHARES1:-0} - ${SHARES0:-0}}")
if [ "$DELTA" = "100000000" ]; then echo "pass  HAPPY approve->deposit(self,100e6) settled: shares $SHARES0->$SHARES1 (approve=$APPV_TX deposit=$DEP_TX)"; pass=$((pass+1)); else echo "FAIL  deposit shares delta=$DELTA (want 100000000)"; fail=$((fail+1)); fi

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
  "depositDecoder": {
    "vault": "$VAULT",
    "redirectRevert": "RecipientNotSelf 0x239e7696",
    "overCapRevert": "OverPerCallCap 0x2671b8a6",
    "happyApproveTx": "$APPV_TX",
    "happyDepositTx": "$DEP_TX",
    "sharesBefore": "$SHARES0",
    "sharesAfter": "$SHARES1"
  },
  "checks": { "passed": $pass, "failed": $fail },
  "vectors": ["approve(max)", "off-allowlist spender", "over per-call cap", "off-allowlist target", "malicious real-tx revert", "deposit redirect (RecipientNotSelf)", "deposit over per-call cap", "deposit happy self-credit"]
}
JSON
echo "evidence → docs/evidence/stage-d-adversarial-drill.json"
[ $fail -eq 0 ]
