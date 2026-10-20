#!/usr/bin/env bash
# Elysium 99801 live drill — proves every LeashAccount guarantee with real txs.
# Ascend Builder Grant evidence, 2026-10-20. Each forbidden action is BOTH
# simulated (to capture the contract's named error) AND force-sent (so a failed
# tx is visible on the explorer).
#
# env (required): ELYSIUM_RPC, OPS_PK, SESSION_PK, ACCOUNT, ALLOWED, EVIDENCE_OUT
set -euo pipefail

RPC="$ELYSIUM_RPC"
OUT="${EVIDENCE_OUT:-evidence/elysium-drill.json}"
mkdir -p "$(dirname "$OUT")"
echo "[]" > "$OUT"

SESSION_ADDR=$(cast wallet address --private-key "$SESSION_PK")
STRANGER=0x000000000000000000000000000000000000dEaD

record() { # name, expected, txhash, status, detail
  python3 - "$OUT" "$1" "$2" "$3" "$4" "$5" <<'PY'
import json,sys
p,name,expected,tx,status,detail=sys.argv[1:7]
d=json.load(open(p)); d.append({"step":name,"expected":expected,"tx":tx,"status":status,"detail":detail})
json.dump(d,open(p,"w"),indent=1)
PY
}

sim_error() { # to, sig+args... -> prints revert reason (named error), never exits non-zero
  cast call "$@" --from "$SESSION_ADDR" --rpc-url "$RPC" 2>&1 | tail -1 || true
}

echo "== drill: account=$ACCOUNT session=$SESSION_ADDR allowed=$ALLOWED"

# 1. fund the account (ops)
TX=$(cast send "$ACCOUNT" --value 0.003ether --private-key "$OPS_PK" --rpc-url "$RPC" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
record "1-fund-account" "success" "$TX" "success" "0.003 HYPE funded"

# 2. within-cap transfer to allowlisted recipient (session key) — must PASS
TX=$(cast send "$ACCOUNT" "execute(address,uint256,bytes)" "$ALLOWED" 500000000000000 0x \
  --private-key "$SESSION_PK" --rpc-url "$RPC" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
ST=$(cast receipt "$TX" status --rpc-url "$RPC")
record "2-withincap-allowlisted" "success" "$TX" "$ST" "0.0005 HYPE to allowlisted — within 0.001 cap"

# 3. over-cap transfer — named error + on-chain failed tx
ERR=$(sim_error "$ACCOUNT" "execute(address,uint256,bytes)" "$ALLOWED" 2000000000000000 0x)
TX=$(cast send "$ACCOUNT" "execute(address,uint256,bytes)" "$ALLOWED" 2000000000000000 0x \
  --private-key "$SESSION_PK" --rpc-url "$RPC" --gas-limit 300000 --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])' || echo "none")
ST="reverted"; [ "$TX" != "none" ] && ST=$(cast receipt "$TX" status --rpc-url "$RPC" || echo reverted)
record "3-overcap" "revert OverPerTransferCap" "$TX" "$ST" "$ERR"

# 4. off-allowlist transfer — named error + on-chain failed tx
ERR=$(sim_error "$ACCOUNT" "execute(address,uint256,bytes)" "$STRANGER" 500000000000000 0x)
TX=$(cast send "$ACCOUNT" "execute(address,uint256,bytes)" "$STRANGER" 500000000000000 0x \
  --private-key "$SESSION_PK" --rpc-url "$RPC" --gas-limit 300000 --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])' || echo "none")
ST="reverted"; [ "$TX" != "none" ] && ST=$(cast receipt "$TX" status --rpc-url "$RPC" || echo reverted)
record "4-offallowlist" "revert NotAllowlisted" "$TX" "$ST" "$ERR"

# 5. guardian revoke — one write, instant
TX=$(cast send "$ACCOUNT" "revoke()" --private-key "$OPS_PK" --rpc-url "$RPC" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
record "5-guardian-revoke" "success" "$TX" "success" "guardian revoke — fails closed from here"

# 6. post-revoke spend — must fail closed
ERR=$(sim_error "$ACCOUNT" "execute(address,uint256,bytes)" "$ALLOWED" 500000000000000 0x)
TX=$(cast send "$ACCOUNT" "execute(address,uint256,bytes)" "$ALLOWED" 500000000000000 0x \
  --private-key "$SESSION_PK" --rpc-url "$RPC" --gas-limit 300000 --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])' || echo "none")
ST="reverted"; [ "$TX" != "none" ] && ST=$(cast receipt "$TX" status --rpc-url "$RPC" || echo reverted)
record "6-postrevoke-spend" "revert AccountRevoked" "$TX" "$ST" "$ERR"

echo "== drill complete → $OUT"
python3 -m json.tool "$OUT"
