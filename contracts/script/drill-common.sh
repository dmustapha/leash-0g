#!/usr/bin/env bash
# SE-4 shared drill library — baseline-reset preamble + bounded RPC-flake tolerance, sourced
# by every deployed drill so each re-produces its full green score ON DEMAND (E-4). One
# deployed-stack config drives all drills (DRILL_STACK), so SE-5's per-chain registry can
# point them at another chain without forking the drill bodies.
#
# Two hard rules (the SD deploy-review finding):
#   1. A transient 0G RPC failure (timeout, async receipt drop, empty response) is RETRIED a
#      bounded number of times — never recorded as a logic PASS or FAIL.
#   2. A genuine assertion FAIL (a call that should revert but succeeded, or reverts with the
#      WRONG selector) is NEVER masked as a flake.

# ---- stack config --------------------------------------------------------------------------
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL_STACK="${DRILL_STACK:-$_LIB_DIR/stacks/0g-16602.sh}"
# shellcheck disable=SC1090
source "$DRILL_STACK"
RPC="$STACK_RPC"; KEY="$STACK_KEY"; A="$STACK_ACCOUNT"
SESSION_ADDR=$(cast wallet address --private-key "$KEY")   # session key == owner in the drill account

FLAKE_RETRIES="${FLAKE_RETRIES:-8}"     # bounded retries for a transient RPC failure
FLAKE_SLEEP="${FLAKE_SLEEP:-4}"

# a transient TRANSPORT failure — retryable, NOT a logic result. Deliberately narrow (only
# transport-layer phrasings) and does NOT match "execution reverted" / a 4-byte 0x… selector,
# so a genuine revert is never swallowed as a flake (SE-4 E-13: no real failure masked).
_is_flake() {
  echo "$1" | grep -qiE 'error sending request|timed? ?out|timeout|connection refused|connection reset|econnreset|reset by peer|deadline|429|502|503|504|empty response|failed to (get|fetch|send)|could not (get|fetch|connect|send)|temporarily unavailable'
}

# ---- transactions --------------------------------------------------------------------------
# Submit --async (returns the hash immediately, no receipt wait — this RPC intermittently
# null-responses on the synchronous receipt even though the tx mines). Bounded retry ONLY on
# a flaked submit; a client-side revert propagates.
send_async() {
  local out i
  for i in $(seq 1 "$FLAKE_RETRIES"); do
    if out=$(cast send "$@" --private-key "$KEY" --rpc-url "$RPC" --legacy --gas-price "$STACK_GAS_PRICE" ${SEND_GAS_LIMIT:+--gas-limit "$SEND_GAS_LIMIT"} --async 2>&1); then
      echo "$out" | grep -oE '0x[0-9a-fA-F]{64}' | head -1; return 0
    fi
    _is_flake "$out" || { echo "SENDREVERT:${out//$KEY/<redacted>}" >&2; return 1; }   # genuine client-side revert (key redacted)
    sleep "$FLAKE_SLEEP"
  done
  echo "" ; return 1   # exhausted flake budget
}

# Submit AND wait for the tx to mine before returning — serializes owner txs so their nonces
# never race (the next send sees the confirmed nonce). Confirms via NONCE ADVANCEMENT (the
# account nonce increments when the tx mines) rather than the receipt: this RPC intermittently
# null-responds on `cast receipt` even for mined txs, but the nonce read is reliable. Echoes the
# tx hash. Use for sequential owner grant txs (reset preamble, authorizeOnce, propose/applyCallRule).
send_confirmed() {
  local n0 h i n1
  n0=$(cast nonce "$SESSION_ADDR" --rpc-url "$RPC" 2>/dev/null)
  h=$(send_async "$@") || return 1
  for i in $(seq 1 "$((FLAKE_RETRIES * 4))"); do
    n1=$(cast nonce "$SESSION_ADDR" --rpc-url "$RPC" 2>/dev/null)
    if [ -n "$n1" ] && [ -n "$n0" ] && [ "$n1" -gt "$n0" ]; then echo "$h"; return 0; fi
    sleep "$FLAKE_SLEEP"
  done
  echo "$h"; return 0   # nonce read never advanced within budget; tx likely mined — caller re-reads state
}

# $1 = tx hash → echoes receipt status: "1" success, "0" revert, "" flake-exhausted.
wait_status() {
  local h="$1" i st
  [ -z "$h" ] && { echo ""; return 1; }
  for i in $(seq 1 "$((FLAKE_RETRIES * 4))"); do
    st=$(cast receipt "$h" status --rpc-url "$RPC" 2>/dev/null | tr -d '[:space:]')
    case "$st" in 0|1) echo "$st"; return 0;; esac
    sleep "$FLAKE_SLEEP"
  done
  echo ""; return 1
}

# ---- reads (flake-tolerant) ----------------------------------------------------------------
# a numeric read that retries through empty/flaked responses.
num_read() {
  local v i
  for i in $(seq 1 "$FLAKE_RETRIES"); do
    v=$(cast call "$@" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
    case "$v" in ''|*[!0-9]*) ;; *) echo "$v"; return 0;; esac
    sleep "$FLAKE_SLEEP"
  done
  echo ""; return 1
}

# ---- assertion primitives (record pass/fail; never conflate a flake) -----------------------
pass=0; fail=0; flake=0
note() { echo "  $1"; }
_pass() { echo "pass  $1"; pass=$((pass+1)); }
_fail() { echo "FAIL  $1"; fail=$((fail+1)); }
_flake() { echo "FLAKE $1"; flake=$((flake+1)); }   # bounded retries exhausted — inconclusive, NOT a pass

# expect an eth_call (from the session key) to REVERT with a given selector substring.
# Retries ONLY on a transient RPC flake; a success = genuine FAIL; a wrong-selector revert =
# genuine FAIL; the flake budget is bounded and its exhaustion is a FLAKE, never a PASS/FAIL.
expect_revert() { # $1 label  $2 data  $3 want-selector  $4 target
  local label="$1" data="$2" want="$3" target="$4" out i
  for i in $(seq 1 "$FLAKE_RETRIES"); do
    if out=$(cast call "$A" "executeCall(address,uint256,bytes)" "$target" 0 "$data" --from "$SESSION_ADDR" --rpc-url "$RPC" 2>&1); then
      _fail "$label — call SUCCEEDED, expected revert $want"; return
    fi
    if echo "$out" | grep -qiE "$want"; then _pass "$label → reverted with $want"; return; fi
    # A response carrying REVERT DATA (execution reverted / a 4-byte custom-error selector) but
    # NOT the wanted selector is a GENUINE wrong-selector FAIL — decided BEFORE consulting the
    # flake regex, so an incidental flake-keyword in the revert text can never downgrade a real
    # assertion failure to "inconclusive" (E-13).
    if echo "$out" | grep -qiE 'execution reverted|0x[0-9a-fA-F]{8}|custom error'; then
      _fail "$label — reverted but not with $want: $out"; return
    fi
    # No revert data → either a transient transport flake (retry) or a hard non-revert error (FAIL).
    _is_flake "$out" || { _fail "$label — non-revert, non-flake error: $out"; return; }
    sleep "$FLAKE_SLEEP"
  done
  _flake "$label — RPC flake budget exhausted (inconclusive), want $want"
}

# ---- baseline reset preamble ---------------------------------------------------------------
# Restore the drill account to the canonical baseline BEFORE the drill body, so run N+1 starts
# identical to run 1 (owner-signed; timelockDelay=0 → propose+apply is instant). Re-proposing
# a rule OVERWRITES its perCallCap/windowCapCall (applyCallRule sets them directly), which
# normalizes whatever residue a prior run left (a loosened 300e6/400e6 cap → back to 200e6).
_read_rule_cap() { # $1 target  $2 selector -> echoes perCallCap ("" on flake)
  local rk; rk=$(cast keccak "$(cast abi-encode --packed 'f(address,bytes4)' "$1" "$2")")
  cast call "$A" "callRules(bytes32)(bool,uint8,uint128,uint128)" "$rk" --rpc-url "$RPC" 2>/dev/null | sed -n '3p' | awk '{print $1}'
}

# $1 target $2 selector $3 recipientMode $4 spenders-array(e.g. "[0x..]" or "[]")
_regrant() {
  send_confirmed "$A" "proposeCallRule(address,bytes4,uint8,address[],uint128,uint128,bytes32)" \
    "$1" "$2" "$3" "$4" "$BASE_PER_CALL_CAP" "$BASE_WINDOW_CAP" "$BASE_CODEHASH" >/dev/null || return 1
  send_confirmed "$A" "applyCallRule()" >/dev/null || return 1
}

# RESET_BEFORE / RESET_AFTER capture the approve-rule perCallCap so evidence can prove the
# reset actually moved state (the "reset proof").
RESET_BEFORE=""; RESET_AFTER=""
reset_baseline() {
  echo "-- baseline reset preamble (restore canonical caps) --"
  RESET_BEFORE=$(_read_rule_cap "$STACK_USD" "$SEL_APPROVE")
  _regrant "$STACK_USD"   "$SEL_APPROVE" 0 "[$STACK_ROUTER,$STACK_VAULT]" \
    && note "approve rule → perCallCap=$BASE_PER_CALL_CAP window=$BASE_WINDOW_CAP spenders=[router,vault]" \
    || { _fail "reset: approve re-grant failed (RPC flake exhausted)"; return 1; }
  _regrant "$STACK_VAULT" "$SEL_DEPOSIT" 0 "[]" \
    && note "deposit rule → perCallCap=$BASE_PER_CALL_CAP window=$BASE_WINDOW_CAP recipientMode=self" \
    || { _fail "reset: deposit re-grant failed (RPC flake exhausted)"; return 1; }
  # confirm the approve cap is now the canonical baseline (proves reset landed).
  local i
  for i in $(seq 1 "$FLAKE_RETRIES"); do
    RESET_AFTER=$(_read_rule_cap "$STACK_USD" "$SEL_APPROVE")
    [ "$RESET_AFTER" = "$BASE_PER_CALL_CAP" ] && { note "reset proof: approve perCallCap $RESET_BEFORE → $RESET_AFTER"; return 0; }
    sleep "$FLAKE_SLEEP"
  done
  _fail "reset: approve perCallCap did not settle to $BASE_PER_CALL_CAP (got '$RESET_AFTER')"; return 1
}

# ---- result line (shared) ------------------------------------------------------------------
# A drill is GREEN iff fail==0 AND flake==0 (an inconclusive flaked run is NOT green — re-run).
result_line() { echo ""; echo "RESULT: $pass passed, $fail failed, $flake flaked"; }
drill_green() { [ "$fail" -eq 0 ] && [ "$flake" -eq 0 ]; }
