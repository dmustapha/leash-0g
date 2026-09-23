// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {LeashAccountFactory} from "../src/LeashAccountFactory.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// Deploys the Phase-1 singletons (AgentRegistry + LeashAccountFactory) to 0G testnet.
/// LeashAccounts are deployed per-agent by the backend through the factory.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        AgentRegistry registry = new AgentRegistry();
        LeashAccountFactory factory = new LeashAccountFactory();
        vm.stopBroadcast();
        console.log("AgentRegistry:", address(registry));
        console.log("LeashAccountFactory:", address(factory));
    }
}

/// Phase-4 v3 redeploy: factory v3 (token-capable) + TestUSD. Runs against the
/// existing AgentRegistry (unchanged — it stores no policy). Record both
/// addresses + tx hashes (untruncated) in DEPLOYMENTS.md.
contract DeployV3 is Script {
    function run() external {
        vm.startBroadcast();
        LeashAccountFactory factory = new LeashAccountFactory();
        MockERC20 testUsd = new MockERC20("Test USD (LEASH testnet)", "TestUSD", 6);
        vm.stopBroadcast();
        console.log("LeashAccountFactory (v3):", address(factory));
        console.log("MockERC20 (TestUSD):", address(testUsd));
    }
}
