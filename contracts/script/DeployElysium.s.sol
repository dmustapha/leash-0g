// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {LeashAccountFactory} from "../src/LeashAccountFactory.sol";
import {LeashAccount} from "../src/LeashAccount.sol";

/// Elysium testnet (99801) deploy — Ascend Builder Grant drill, 2026-10-20.
/// Deploys the production singletons (AgentRegistry + LeashAccountFactory, v3
/// token-capable — same bytecode as the 5 live chains) and one drill-ready
/// governed account with a real policy, so every guarantee can be proven live:
/// within-cap PASS, over-cap / off-allowlist REVERT, guardian revoke fail-closed.
///
/// env: ELYSIUM_SESSION_KEY (agent session address), ELYSIUM_ALLOWED (allowlisted
/// recipient). Owner == guardian == broadcaster (ops key) — testnet drill only.
contract DeployElysium is Script {
    function run() external {
        address ops = msg.sender;
        address sessionKey = vm.envAddress("ELYSIUM_SESSION_KEY");
        address allowed = vm.envAddress("ELYSIUM_ALLOWED");

        vm.startBroadcast();
        AgentRegistry registry = new AgentRegistry();
        LeashAccountFactory factory = new LeashAccountFactory();

        LeashAccount.Policy memory pol = LeashAccount.Policy({
            perTransferCap: 0.001 ether,
            windowCap: 0.003 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 30 days)
        });
        address[] memory allow = new address[](1);
        allow[0] = allowed;
        // timelockDelay = 0 so the drill runs in one session (testnet only);
        // native-only account (settlementToken = 0) — the drill proves the native path.
        address acct = factory.createAccount(
            ops, ops, sessionKey, pol, allow, 0, address(0), LeashAccount.TokenPolicy(0, 0)
        );
        vm.stopBroadcast();

        console.log("AgentRegistry:", address(registry));
        console.log("LeashAccountFactory:", address(factory));
        console.log("DrillAccount:", acct);
    }
}
