#!/usr/bin/env bash
# RH2 on-chain evidence capture — HOTFIX-NOW item 2 (Gate-② send-back 2026-10-07).
# Persists FULL tx hashes + unmasked receipts (on-chain `status`) for the RH2 demo txs
# to docs/evidence/rh2-onchain-evidence.json. Does NOT send explicit gas and does NOT
# mask reverts — it reads the mined receipt `status` field directly (0 = reverted, 1 = success).
# Reproduce: bash scripts/rh2-evidence-capture.sh
set -euo pipefail

RPC="${RH_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
EXPLORER="https://explorer.testnet.chain.robinhood.com/tx"
OUT="docs/evidence/rh2-onchain-evidence.json"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"

# beat:expected_status:hash  (expected_status is the ASSERTION, verified against the live receipt)
TXS=(
  "in_band_swap_success:1:0x39b01a438013e504b41dc956fe14d6e44d03cf12545eb2e7cb37af10b5c4d8ee"
  "governed_approve_success:1:0xab542c5a555039f14d70580d9248fbc54a0cee8a6b5818356db5d4145a1f7678"
  "premium_breach_revert:0:0xd14e21dad6f615b092369bd32ebc46b09479ebe6a9e5324a1f5714bb90dc6fb7"
  "stale_oracle_revert:0:0x5bfc22df244b25bb6a840bf8a1ba31d0c2b723ace7f31aeba805fafcb8bc8042"
)

retry_receipt() { # $1 hash  -> prints JSON receipt or exits 1
  local hash="$1" out
  for _ in $(seq 1 12); do
    out="$(cast receipt "$hash" --rpc-url "$RPC" --json 2>/dev/null || true)"
    if [ -n "$out" ] && echo "$out" | grep -q '"status"'; then echo "$out"; return 0; fi
    sleep 3
  done
  echo "FAILED to fetch receipt for $hash after retries" >&2; return 1
}

echo "{" > "$OUT"
echo "  \"capturedBy\": \"scripts/rh2-evidence-capture.sh\"," >> "$OUT"
echo "  \"chainId\": $CHAIN_ID," >> "$OUT"
echo "  \"rpcUrl\": \"$RPC\"," >> "$OUT"
echo "  \"note\": \"Unmasked receipts: on-chain status read directly from the mined receipt. status 0 == reverted (intended fail-closed), status 1 == success.\"," >> "$OUT"
echo "  \"txs\": [" >> "$OUT"

n=${#TXS[@]}
for i in "${!TXS[@]}"; do
  IFS=':' read -r beat expected hash <<< "${TXS[$i]}"
  receipt="$(retry_receipt "$hash")"
  actual="$(echo "$receipt" | cast --json 2>/dev/null >/dev/null; echo "$receipt" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["status"],16))')"
  pass=$([ "$actual" = "$expected" ] && echo true || echo false)
  comma=$([ "$i" -lt "$((n-1))" ] && echo "," || echo "")
  {
    echo "    {"
    echo "      \"beat\": \"$beat\","
    echo "      \"txHash\": \"$hash\","
    echo "      \"explorer\": \"$EXPLORER/$hash\","
    echo "      \"expectedStatus\": $expected,"
    echo "      \"onChainStatus\": $actual,"
    echo "      \"assertionPass\": $pass,"
    echo "      \"receipt\": $receipt"
    echo "    }$comma"
  } >> "$OUT"
  echo "  $beat -> onchain status=$actual expected=$expected pass=$pass"
done

echo "  ]" >> "$OUT"
echo "}" >> "$OUT"
echo "Wrote $OUT"
