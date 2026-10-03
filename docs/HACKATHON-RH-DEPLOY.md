# Robinhood Chain testnet deploy — LEASH oracle-aware wall (Arbitrum Open House)

**Chain:** Robinhood Chain testnet (Orbit L2), chainId **46630**, gas = ETH.
**Deployer:** `0xc211C942946011859ca634F22400d80570ED12A5`
**Explorer:** https://explorer.testnet.chain.robinhood.com
**Date:** 2026-10-03 · **Branch:** `hackathon-robinhood` · rung 3 (faithful mocks, real interfaces)

## Deployed + Blockscout-verified contracts

| Contract | Address |
|---|---|
| AgentRegistry | `0xf2943580DABc1dd5eD417a5DC58D35110640BB2f` |
| LeashAccountV4Factory | `0xE68ceD9a57168b2A7F889419345C43dFA89C38CC` |
| MockERC20 sUSD (18dp) | `0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06` |
| MockERC20 sTSLA (18dp) | `0xB9431b3be9a56a1eeA8E728326332f8B4dD51382` |
| MockRouter | `0x4964991514f731CB3CF252108dFF889d30036fcb` |
| MockAggregatorV3 (8dp, TSLA=$100) | `0x8E107bAC6f430aecB8Aa11B383E9690e9a5214bE` |
| LeashAccountV4 (governed account) | `0x4FaEe24384795358a736e9BCADd22C8d975E240f` |
| LeashAccountV4FactoryDeterministic | `0x93Bb77c3d9458f4738501fA82d7506225d61F767` |

> The deterministic factory (CREATE2 via Arachnid `0x4e59…4956C`, salt
> `keccak256("LEASH-V4-DETERMINISTIC-FACTORY-v1")`) is what the backend `deployAndRegister`
> wire uses to onboard a RH-home agent. It lands at a NEW address (`0x93Bb…F767`) rather than
> the production `0x9C10…E46f` because the price-band branch changes the wall bytecode — honest:
> it shares an address only with other chains running this branch's factory, not production.

All 7 verified on Blockscout (self-hosted, no API key). The account is granted: `approve(sUSD→router)`
within a 5,000-sUSD budget, governed `swap(router)`, and a **5% price band** on the swap priced off the
mock equity feed (asset = sTSLA, 1h staleness).

## On-chain demo evidence (real txs)

| Beat | Tx | Status |
|---|---|---|
| Agent trades sanely — 100 sUSD → 100 sTSLA, implied $100 (in band) | `0x39b01a438013e504b41dc956fe14d6e44d03cf12545eb2e7cb37af10b5c4d8ee` | ✅ success |
| Governed approve(router, 2000 sUSD) | `0xab542c5a555039f14d70580d9248fbc54a0cee8a6b5818356db5d4145a1f7678` | ✅ success |
| **HERO — premium trade blocked:** 130 sUSD → 1 sTSLA, implied $130 > $105 band | `0xd14e21dad6f615b092369bd32ebc46b09479ebe6a9e5324a1f5714bb90dc6fb7` | ⛔ reverted `PremiumBreach(130e18,105e18)` |
| **Fail-closed — stale feed:** in-band-priced trade on a 2h-stale feed | `0x5bfc22df244b25bb6a840bf8a1ba31d0c2b723ace7f31aeba805fafcb8bc8042` | ⛔ reverted `StaleOracle(updatedAt,3600)` |

Both reverts carry the intended custom-error selectors (`0xb9947793` / `0x4f725aba`), not out-of-gas.
Feed left fresh at $100 (demo-ready).

## Reproduce
`forge script script/Deploy.s.sol:DeployRobinhood` (local sim) · broadcast + Blockscout-verify commands in
`tasks/hackathon-robinhood.md`. Note: forge's HTTP client throws TLS `BadRecordMac` against the RH RPC;
deploy/broadcast go through `contracts/rpc-relay.cjs` (plain-HTTP→HTTPS localhost relay). `cast` is unaffected.
