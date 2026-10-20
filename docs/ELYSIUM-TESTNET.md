# LEASH on Elysium testnet (chain 99801) — 2026-10-20

Deployed from this branch (`elysium-port`, cut from the production commit) for the Ascend Builder Grant.
Explorer: https://elysium.kinetiq.xyz/testnet-explorer

## Contracts (all Blockscout-verified)
| Contract | Address |
|---|---|
| AgentRegistry | `0xf2943580DABc1dd5eD417a5DC58D35110640BB2f` |
| LeashAccountFactory (v3, token-capable — same source as the 5 production chains) | `0xE68ceD9a57168b2A7F889419345C43dFA89C38CC` |
| Drill LeashAccount (live policy: 0.001 HYPE per-transfer cap, 0.003 window cap / 1h, allowlist of 1, guardian revoke) | `0x4FaEe24384795358a736e9BCADd22C8d975E240f` |

## Live drill — every guarantee proven by a real transaction
| # | Step | Expected | Tx |
|---|---|---|---|
| 1 | Fund account 0.003 HYPE | success | `0x635f28b1ac8bbe9f2b7cfead1b2cdfa4be4d7ed38ae80e89c8535fa95b3a323e` |
| 2 | Session key: within-cap transfer to allowlisted | success | `0x651b09b09c38b6b53143e1592c7297176aeff7534befcb4630824395f79249f6` |
| 3 | Session key: over-cap transfer | revert `OverPerTransferCap` (`0x80a03d15`, value 0.002 vs cap 0.001 in revert data) | `0x125e3979a04b1c433f43642a2986c7a87f6d052b3fb4067855f6aab4fb7764ad` (failed on-chain) |
| 4 | Session key: transfer to non-allowlisted | revert `NotAllowlisted` (`0x6f7a5275`) | `0x6d777d66156d0fa8e73b8b1fdf5ec50f9ce70084075a9aba9e1990a46cb99d0f` (failed on-chain) |
| 5 | Guardian revoke (one write) | success | `0xdee8941cb34ccbcaca79844ac96d5568fa06f91cf3eba1197c2a925420c6b622` |
| 6 | Session key: any further spend | revert `AccountRevoked` (`0x74b17b2b`) — fails closed | `0x510e47a9b8da2093d3a6eb4d6f34e7caceb4d48e0c512dce9c91f7713c32ad1b` (failed on-chain) |

Raw evidence: `contracts/evidence/elysium-drill.json`. Reproduce: `contracts/script/DeployElysium.s.sol` + `contracts/script/elysium-drill.sh`.
Note: forge needs a plain-HTTP relay to this RPC (rustls BadRecordMac); `cast`/`curl` work via relay too.
