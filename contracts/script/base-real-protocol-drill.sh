#!/usr/bin/env bash
# SE-7 (E-7) DEPLOYED REAL-PROTOCOL DRILL — the governed-calldata wall meeting REAL
# deployed protocols on Base Sepolia (nothing mocked):
#   - Uniswap SwapRouter02: a governed swap (WETH→USDC) LANDS against real pool
#     liquidity, submitted through the router's REAL multicall(deadline,bytes[])
#     envelope (real liquidity / real gas / real multicall).
#   - Aave v3 (via stataWETH, the ERC-4626 wrapper over aWETH): a governed
#     deposit(assets, SELF) lands a REAL Aave supply, guarded by the structured
#     deposit decoder (recipient pinned self).
#   - Permit2: a governed BOUNDED approve to the real Permit2 lands within caps.
#   - The FULL malicious matrix REVERTS at the true boundary against the real
#     contracts: InfiniteApprovalForbidden · SpenderNotAllowlisted · OverPerCallCap
#     · TargetNotAllowlisted (real code-bearing Aave Pool, never granted) · deposit
#     RecipientNotSelf — plus a REAL malicious tx reverting on-chain.
#
# SE-4: deterministic CREATE2 drill account (fixed salt; mint-if-absent), baseline-
# reset preamble, bounded RPC-flake retries — full green score reproducible ON
# DEMAND. Writes docs/evidence/stage-e-base-real-protocol-drill.json.
set -euo pipefail
DRILL_STACK="${DRILL_STACK:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stacks/base-sepolia-84532.sh}"
export DRILL_STACK
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/drill-common.sh"

WETH="$STACK_USD"; ROUTER="$STACK_ROUTER"; VAULT="$STACK_VAULT"
PERMIT2="$STACK_PERMIT2"; USDC="$STACK_USDC"; POOL="$STACK_AAVE_POOL"; ATTACKER="$STACK_ATTACKER"
MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
POLICY="(10000000000000000,100000000000000000,3600,2000000000)"   # fixed → deterministic address
TOKENPOL="(0,0)"
ZERO=0x0000000000000000000000000000000000000000

echo "== SE-7 Base Sepolia REAL-protocol drill (stack=$STACK_NAME) =="

# ── deterministic drill account: predict → mint-if-absent (idempotent) ─────────
predict() {
  cast call "$STACK_FACTORY_V4" \
    "predictAccountV4(address,address,address,(uint128,uint128,uint32,uint64),address[],uint64,address,(uint128,uint128),bytes32)(address)" \
    "$SESSION_ADDR" "$STACK_GUARDIAN" "$SESSION_ADDR" "$POLICY" "[]" 0 "$ZERO" "$TOKENPOL" "$STACK_DRILL_SALT" \
    --rpc-url "$RPC" 2>/dev/null
}
A=""
for i in $(seq 1 "$FLAKE_RETRIES"); do A=$(predict) && [ -n "$A" ] && break; sleep "$FLAKE_SLEEP"; done
[ -z "$A" ] && { echo "FATAL: predictAccountV4 exhausted flake budget"; exit 1; }
echo "drill account (CREATE2, fixed salt): $A"

# Flake-tolerant code probe: an empty read is retried — only a CONFIRMED "0x"
# (RPC answered, no code) triggers a mint. A racing/duplicate mint reverting
# AccountAlreadyDeployed is ADOPTED (CREATE2: code at the prediction IS the
# byte-exact account — the M-02 adopt-existing posture).
CODE=""
for i in $(seq 1 "$FLAKE_RETRIES"); do
  CODE=$(cast code "$A" --rpc-url "$RPC" 2>/dev/null) && [ -n "$CODE" ] && break
  sleep "$FLAKE_SLEEP"
done
MINT_TX="pre-existing"
if [ "$CODE" = "0x" ]; then
  echo "-- minting drill account via deterministic factory --"
  MINT_TX=$(send_confirmed "$STACK_FACTORY_V4" \
    "createAccountV4(address,address,address,(uint128,uint128,uint32,uint64),address[],uint64,address,(uint128,uint128),bytes32)" \
    "$SESSION_ADDR" "$STACK_GUARDIAN" "$SESSION_ADDR" "$POLICY" "[]" 0 "$ZERO" "$TOKENPOL" "$STACK_DRILL_SALT" 2>/tmp/se7-mint-err) \
    || { grep -q "AccountAlreadyDeployed" /tmp/se7-mint-err 2>/dev/null && { MINT_TX="adopted (AccountAlreadyDeployed)"; note "adopting pre-existing deterministic deploy"; } || { echo "FATAL: mint failed"; cat /tmp/se7-mint-err 2>/dev/null; exit 1; }; }
  for i in $(seq 1 "$((FLAKE_RETRIES * 4))"); do
    CODE=$(cast code "$A" --rpc-url "$RPC" 2>/dev/null || echo "")
    [ -n "$CODE" ] && [ "$CODE" != "0x" ] && break
    sleep "$FLAKE_SLEEP"
  done
  [ -z "$CODE" ] || [ "$CODE" = "0x" ] && { echo "FATAL: minted account shows no code (RPC lag exhausted)"; exit 1; }
  note "minted at prediction: $A (tx=$MINT_TX)"
fi

# ── gas/asset funding: the account pays swap/wrap value from its own balance ───
BAL=$(cast balance "$A" --rpc-url "$RPC" 2>/dev/null || echo 0)
if [ "${BAL:-0}" -lt 4000000000000000 ] 2>/dev/null; then
  echo "-- funding drill account with 0.005 ETH --"
  send_confirmed "$A" --value 5000000000000000 >/dev/null || { echo "FATAL: funding failed"; exit 1; }
fi

# ── baseline reset (SE-4): canonical caps restored before every body ──────────
reset_baseline || { result_line; exit 1; }
# SE-7 extra grants (idempotent overwrites — applyCallRule sets caps directly):
#   approve spender set gains the REAL Permit2; WETH wrap, router swap + router
#   multicall envelope granted as value-charged (non-structured) rules.
_regrant "$WETH"   "$SEL_APPROVE" 0 "[$ROUTER,$VAULT,$PERMIT2]" \
  && note "approve rule → spenders=[SwapRouter02, stataWETH, Permit2]" \
  || { _fail "reset: approve+permit2 re-grant failed"; result_line; exit 1; }
_regrant "$WETH"   "$SEL_WETH_DEPOSIT" 0 "[]" \
  && note "WETH.deposit() rule → wrap charged vs perCallCap ($BASE_PER_CALL_CAP)" \
  || { _fail "reset: WETH.deposit re-grant failed"; result_line; exit 1; }
_regrant "$ROUTER" "$SEL_EXACT_INPUT_SINGLE" 0 "[]" \
  && note "router exactInputSingle rule granted" \
  || { _fail "reset: exactInputSingle re-grant failed"; result_line; exit 1; }
_regrant "$ROUTER" "$SEL_MULTICALL_DEADLINE" 0 "[]" \
  && note "router multicall(deadline,bytes[]) rule granted" \
  || { _fail "reset: multicall re-grant failed"; result_line; exit 1; }

# Cumulative per-token SPEND BUDGETS (D-3 spine): approve charges spendBudget[WETH],
# the wrap charges spendBudget[native 0x0], the 4626 deposit charges spendBudget[vault].
# timelockDelay=0 → propose+apply instant; re-proposing normalizes residue (idempotent).
grant_budget() { # $1 token
  send_confirmed "$A" "proposeSpendBudget(address,uint128)" "$1" "$BASE_WINDOW_CAP" >/dev/null || return 1
  _apply_when_elapsed "applySpendBudget()" >/dev/null || return 1
}
grant_budget "$WETH"  && note "spendBudget[WETH] → $BASE_WINDOW_CAP"   || { _fail "reset: WETH budget grant failed"; result_line; exit 1; }
grant_budget "$ZERO"  && note "spendBudget[native] → $BASE_WINDOW_CAP" || { _fail "reset: native budget grant failed"; result_line; exit 1; }
grant_budget "$VAULT" && note "spendBudget[vault] → $BASE_WINDOW_CAP"  || { _fail "reset: vault budget grant failed"; result_line; exit 1; }

echo "-- drill body --"
weth_bal()  { num_read "$WETH" "balanceOf(address)(uint256)" "$A"; }
usdc_bal()  { num_read "$USDC" "balanceOf(address)(uint256)" "$A"; }
share_bal() { num_read "$VAULT" "balanceOf(address)(uint256)" "$A"; }
allowance() { num_read "$WETH" "allowance(address,address)(uint256)" "$A" "$1"; }

# ── HAPPY 1: governed WETH wrap (real WETH, msg.value charged vs the rule cap) ─
WETH0=$(weth_bal); WRAP_TX="skipped (balance sufficient)"
if [ "${WETH0:-0}" -lt 1600000000000000 ] 2>/dev/null; then
  WRAP_TX=$(send_confirmed "$A" "executeCall(address,uint256,bytes)" "$WETH" 1500000000000000 "$SEL_WETH_DEPOSIT" || true)
  WETH1=""
  for i in $(seq 1 "$((FLAKE_RETRIES * 2))"); do
    WETH1=$(weth_bal); [ -n "$WETH1" ] && [ "$WETH1" -gt "${WETH0:-0}" ] 2>/dev/null && break; sleep "$FLAKE_SLEEP"
  done
  if [ -n "$WETH1" ] && [ "$WETH1" -gt "${WETH0:-0}" ] 2>/dev/null; then
    _pass "HAPPY governed WETH wrap landed (real WETH): $WETH0 → $WETH1 tx=$WRAP_TX"
  elif [ -z "$WETH1" ]; then _flake "WETH wrap balance read exhausted"
  else _fail "WETH wrap did not credit (bal $WETH0 → ${WETH1:-?}) tx=$WRAP_TX"; fi
else
  _pass "HAPPY WETH wrap previously landed (balance $WETH0 ≥ 1.6e15; idempotent skip)"
fi

# ── HAPPY 2: bounded governed approve → REAL Permit2 (the Permit2 leg) ─────────
P2_TX=$(send_confirmed "$A" "executeCall(address,uint256,bytes)" "$WETH" 0 "$(cast calldata 'approve(address,uint256)' "$PERMIT2" 100000000000000)" || true)
P2_ALLOW=""
for i in $(seq 1 "$((FLAKE_RETRIES * 2))"); do
  P2_ALLOW=$(allowance "$PERMIT2"); [ "$P2_ALLOW" = "100000000000000" ] && break; sleep "$FLAKE_SLEEP"
done
if [ "$P2_ALLOW" = "100000000000000" ]; then _pass "HAPPY bounded approve(Permit2, 1e14) landed tx=$P2_TX"
elif [ -z "$P2_ALLOW" ]; then _flake "Permit2 allowance read exhausted"
else _fail "approve(Permit2) allowance=$P2_ALLOW (want 100000000000000)"; fi

# ── HAPPY 3: governed approve(router) + REAL Uniswap swap via REAL multicall ───
USDC0=$(usdc_bal)
APPR_TX=""
for i in 1 2 3; do
  [ "$(allowance "$ROUTER")" = "2000000000000000" ] && break
  APPR_TX=$(send_confirmed "$A" "executeCall(address,uint256,bytes)" "$WETH" 0 "$(cast calldata 'approve(address,uint256)' "$ROUTER" 2000000000000000)" || true)
  for j in $(seq 1 "$((FLAKE_RETRIES * 2))"); do [ "$(allowance "$ROUTER")" = "2000000000000000" ] && break; sleep "$FLAKE_SLEEP"; done
done
DEADLINE=$(( $(date +%s) + 1800 ))
SWAP_INNER=$(cast calldata "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" "($WETH,$USDC,3000,$A,100000000000000,0,0)")
SWAP_DATA=$(cast calldata "multicall(uint256,bytes[])" "$DEADLINE" "[$SWAP_INNER]")
SWAP_TX=$(send_confirmed "$A" "executeCall(address,uint256,bytes)" "$ROUTER" 0 "$SWAP_DATA" || true)
USDC1=""
for i in $(seq 1 "$((FLAKE_RETRIES * 2))"); do
  USDC1=$(usdc_bal); [ -n "$USDC1" ] && [ "$USDC1" -gt "${USDC0:-0}" ] 2>/dev/null && break; sleep "$FLAKE_SLEEP"
done
if [ -n "$USDC1" ] && [ "$USDC1" -gt "${USDC0:-0}" ] 2>/dev/null; then
  _pass "HAPPY governed REAL Uniswap swap (multicall envelope, real liquidity): USDC $USDC0 → $USDC1 (approve=$APPR_TX swap=$SWAP_TX)"
elif [ -z "$USDC1" ]; then _flake "USDC balance read exhausted after swap"
else _fail "swap did not credit USDC ($USDC0 → ${USDC1:-?}) tx=$SWAP_TX"; fi

# ── HAPPY 4: governed REAL Aave supply via stataWETH deposit(assets, SELF) ─────
SH0=$(share_bal)
for i in 1 2 3; do
  [ "$(allowance "$VAULT")" = "1000000000000000" ] && break
  send_confirmed "$A" "executeCall(address,uint256,bytes)" "$WETH" 0 "$(cast calldata 'approve(address,uint256)' "$VAULT" 1000000000000000)" >/dev/null || true
  for j in $(seq 1 "$((FLAKE_RETRIES * 2))"); do [ "$(allowance "$VAULT")" = "1000000000000000" ] && break; sleep "$FLAKE_SLEEP"; done
done
DEP_TX=$(send_confirmed "$A" "executeCall(address,uint256,bytes)" "$VAULT" 0 "$(cast calldata 'deposit(uint256,address)' 500000000000000 "$A")" || true)
SH1=""
for i in $(seq 1 "$((FLAKE_RETRIES * 2))"); do
  SH1=$(share_bal); [ -n "$SH1" ] && [ "$SH1" -gt "${SH0:-0}" ] 2>/dev/null && break; sleep "$FLAKE_SLEEP"
done
if [ -n "$SH1" ] && [ "$SH1" -gt "${SH0:-0}" ] 2>/dev/null; then
  _pass "HAPPY governed REAL Aave supply (stataWETH 4626 deposit → self): shares $SH0 → $SH1 tx=$DEP_TX"
elif [ -z "$SH1" ]; then _flake "stataWETH share read exhausted"
else _fail "stataWETH deposit did not credit shares ($SH0 → ${SH1:-?}) tx=$DEP_TX"; fi

# ── MALICIOUS matrix: every vector REVERTS at the wall against REAL contracts ──
expect_revert "approve(max) infinite (real WETH)"        "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$(cast to-dec $MAX)")" "0xcd9e3525" "$WETH"
expect_revert "approve off-allowlist spender (real WETH)" "$(cast calldata 'approve(address,uint256)' "$ATTACKER" 1000000000000)" "0x6eed196c" "$WETH"
expect_revert "approve over per-call cap (real WETH)"     "$(cast calldata 'approve(address,uint256)' "$ROUTER" 3000000000000000)" "0x2671b8a6" "$WETH"
expect_revert "off-allowlist target (REAL Aave Pool)"     "$(cast calldata 'approve(address,uint256)' "$ROUTER" 1000000000000)" "0x042a9b0d" "$POOL"
expect_revert "deposit redirect to attacker (real Aave)"  "$(cast calldata 'deposit(uint256,address)' 100000000000000 "$ATTACKER")" "0x239e7696" "$VAULT"
expect_revert "deposit over per-call cap (real Aave)"     "$(cast calldata 'deposit(uint256,address)' 3000000000000000 "$A")" "0x2671b8a6" "$VAULT"

# ── MALICIOUS real tx reverts on-chain (approve max on real WETH) ──────────────
MAXDEC=$(cast to-dec $MAX)
ROUTER_ALLOW_BEFORE=$(allowance "$ROUTER")
MAXTX=$(SEND_GAS_LIMIT=300000 send_confirmed "$A" "executeCall(address,uint256,bytes)" "$WETH" 0 "$(cast calldata 'approve(address,uint256)' "$ROUTER" "$MAXDEC")" || true)
ROUTER_ALLOW_AFTER=$(allowance "$ROUTER")
if [ -z "$ROUTER_ALLOW_AFTER" ]; then _flake "MALICIOUS approve(max) real-tx allowance read exhausted tx=$MAXTX"
elif [ "$ROUTER_ALLOW_AFTER" = "$MAXDEC" ]; then _fail "MALICIOUS approve(max) real tx SUCCEEDED — allowance=max tx=$MAXTX"
else _pass "MALICIOUS approve(max) real tx reverted on-chain (allowance $ROUTER_ALLOW_BEFORE → $ROUTER_ALLOW_AFTER, not max) tx=$MAXTX"; fi

result_line
mkdir -p ~/leash/docs/evidence
cat > ~/leash/docs/evidence/stage-e-base-real-protocol-drill.json <<JSON
{
  "phase": "Stage E — SE-7 Base Sepolia real protocols (E-7)",
  "kind": "deployed real-protocol drill (idempotent, SE-4)",
  "stack": "$STACK_NAME",
  "chainId": $STACK_CHAIN_ID,
  "account": "$A",
  "accountSalt": "$STACK_DRILL_SALT",
  "factoryV4": "$STACK_FACTORY_V4",
  "mintTx": "$MINT_TX",
  "realProtocols": {
    "weth": "$WETH",
    "uniswapSwapRouter02": "$ROUTER",
    "aaveStataWETH_erc4626": "$VAULT",
    "permit2": "$PERMIT2",
    "usdc": "$USDC",
    "aavePool_neverAllowlisted": "$POOL"
  },
  "resetProof": { "approvePerCallCapBefore": "$RESET_BEFORE", "approvePerCallCapAfter": "$RESET_AFTER", "canonical": "$BASE_PER_CALL_CAP" },
  "happy": {
    "wethWrapTx": "$WRAP_TX",
    "permit2ApproveTx": "$P2_TX",
    "routerApproveTx": "$APPR_TX",
    "uniswapMulticallSwapTx": "$SWAP_TX",
    "usdcBefore": "$USDC0", "usdcAfter": "$USDC1",
    "aaveDepositTx": "$DEP_TX",
    "stataSharesBefore": "$SH0", "stataSharesAfter": "$SH1"
  },
  "maliciousRealTx": { "approveMaxTx": "$MAXTX", "allowanceAfter": "$ROUTER_ALLOW_AFTER" },
  "checks": { "passed": $pass, "failed": $fail, "flaked": $flake },
  "vectors": ["InfiniteApprovalForbidden", "SpenderNotAllowlisted", "OverPerCallCap(approve)", "TargetNotAllowlisted(real Aave Pool)", "RecipientNotSelf(real 4626 deposit)", "OverPerCallCap(deposit)", "approve(max) real-tx revert"]
}
JSON
echo "evidence → docs/evidence/stage-e-base-real-protocol-drill.json"
drill_green
