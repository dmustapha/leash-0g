# Deployed-stack config — Base Sepolia (chainId 84532), the SE-7 REAL-protocol stack.
# Targets are REAL deployed protocols (nothing mocked): the approve TARGET is real
# WETH, the approve SPENDERS are Uniswap SwapRouter02 + the Aave stataWETH vault
# (+ Permit2, granted by the SE-7 drill body), the deposit TARGET is Aave's
# stataWETH — an ERC-4626 wrapper over aWETH, so a deposit through the wall is a
# REAL Aave v3 supply guarded by the structured deposit(uint256,address) decoder.
STACK_NAME="base-sepolia-84532"
STACK_CHAIN_ID=84532
# BASE_DRILL_RPC env overrides the .env value for a drill run (the .env value is
# the Render-staged public endpoint; a run can point at a healthier RPC).
STACK_RPC="${BASE_DRILL_RPC:-$(grep -E '^BASE_SEPOLIA_RPC=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')}"
STACK_RPC="${STACK_RPC:-https://sepolia.base.org}"
STACK_KEY=$(grep -E '^OPS_PRIVATE_KEY=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
# Base Sepolia accepts legacy txs; gas is cheap — 0.1 gwei clears comfortably.
STACK_GAS_PRICE="${STACK_GAS_PRICE:-100000000}"

# The SE-7 drill account is DETERMINISTIC (CREATE2, fixed salt below): the drill
# predicts the address and mints only when no code is there (idempotent, SE-4).
# STACK_ACCOUNT is resolved by the drill preamble via predictAccountV4.
STACK_ACCOUNT=""
STACK_FACTORY_V4=$(grep -E '^LEASH_FACTORY_V4_ADDR=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
STACK_GUARDIAN=$(grep -E '^GUARDIAN_ADDRESS=' ~/leash/backend/.env | cut -d= -f2- | tr -d '"')
STACK_DRILL_SALT=0x5345372d626173652d7265616c2d70726f746f636f6c2d6472696c6c2d763100  # "SE7-base-real-protocol-drill-v1"

# REAL protocol addresses (verified live 2026-09-30; DEPLOYMENTS.md "SE-7").
STACK_USD=0x4200000000000000000000000000000000000006      # WETH — the granted approve TARGET (drill charge token)
STACK_ROUTER=0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4   # Uniswap SwapRouter02 — granted spender + swap target
STACK_VAULT=0xde7820fFb73059608928cb9e29F6EB1369Ad1342    # Aave stataWETH (ERC-4626) — granted deposit TARGET
STACK_PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3  # Permit2 — granted spender (real-protocol approve leg)
STACK_USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e     # Circle USDC — the swap output asset
STACK_AAVE_POOL=0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27 # Aave v3 Pool — REAL + code-bearing, deliberately NEVER allowlisted
STACK_ATTACKER=0x000000000000000000000000000000000000dEaD

# Canonical baseline (WETH wei units): perCallCap 2e15 = 0.002 WETH; the over-cap
# probes use 3e15. windowCap 1e20 leaves ~50k on-demand re-runs of headroom.
BASE_PER_CALL_CAP=2000000000000000
BASE_WINDOW_CAP=100000000000000000000
BASE_CODEHASH=0x0000000000000000000000000000000000000000000000000000000000000000

SEL_APPROVE=0x095ea7b3
SEL_DEPOSIT=0x6e553f65          # ERC-4626 deposit(uint256,address) — structured, recipient pinned self
SEL_WETH_DEPOSIT=0xd0e30db0     # WETH deposit() — non-structured, charges msg.value
SEL_EXACT_INPUT_SINGLE=0x04e45aaf  # SwapRouter02 exactInputSingle(params)
SEL_MULTICALL_DEADLINE=0x5ae401dc  # SwapRouter02 multicall(uint256 deadline, bytes[] data)
