// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {LeashAccountFactory} from "../src/LeashAccountFactory.sol";

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
