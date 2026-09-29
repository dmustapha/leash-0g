# Deployed-stack config — 0G Galileo testnet (chainId 16602), Stage-D cfabfdb redeploy.
# ONE config object per deployed stack. SE-5's per-chain registry drives the drills by
# pointing DRILL_STACK at a different stacks/<chain>.sh — the drill bodies stay chain-agnostic.
STACK_NAME="0g-16602"
STACK_CHAIN_ID=16602
# RPC + signing key come from the backend .env (session key == owner in the drill account).
STACK_RPC=$(grep -E '^ZERO_G_RPC=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
STACK_KEY=$(grep -E '^OPS_PRIVATE_KEY=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
# 0G enforces a minimum gas price (2 gwei as of 2026-09); cast's default tip is too low and
# the node rejects with "gas price below minimum". Set an explicit floor with margin.
STACK_GAS_PRICE="${STACK_GAS_PRICE:-3000000000}"   # 3 gwei

# Deployed governed-calldata (V4) stack.
STACK_ACCOUNT=0x2FDbfa0e76D4dC455C95C4e7d445595E714cDCDF   # DrillAccount (v4, timelockDelay=0)
STACK_USD=0x4E51f90C8Cf60307E01A6abF555762e69Ef0eC2A       # TUSD-D (granted approve TARGET)
STACK_ROUTER=0x425B8638e1B851486F397715EA414d52A1Ab7a65    # granted approve SPENDER (+ non-allowlisted-target probe)
STACK_VAULT=0x6F370dd513bF45D69178cb2E1BEe2BF15bAFCE87      # MockVault — granted deposit TARGET (recipientMode=self)
STACK_ATTACKER=0x000000000000000000000000000000000000dEaD

# Canonical baseline the reset preamble restores BEFORE every drill body, so run N+1 starts
# identical to run 1. perCallCap 200e6 is the shared boundary: adversarial's 300e6 over-cap
# and jit's 250e6/300e6 preconditions all assume it; the jit always-allow test loosens it to
# 400e6, adversarial residue leaves 300e6 — the reset tightens it back. windowCap 1e12 is
# deliberately huge so the preserved-across-regrant window counter never trips within a
# bounded number of on-demand re-runs (~1e12/5e8 = 2000 runs of headroom).
BASE_PER_CALL_CAP=200000000
BASE_WINDOW_CAP=1000000000000
BASE_CODEHASH=0x0000000000000000000000000000000000000000000000000000000000000000

SEL_APPROVE=0x095ea7b3
SEL_DEPOSIT=0x6e553f65
