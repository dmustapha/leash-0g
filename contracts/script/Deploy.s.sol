// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {LeashAccountFactory} from "../src/LeashAccountFactory.sol";
import {LeashAccountV4Factory} from "../src/LeashAccountV4Factory.sol";
import {LeashAccountV4} from "../src/LeashAccountV4.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {MockVault} from "../src/MockVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

/// Stage D deploy: the V4-capable factory + mock targets (MockRouter/MockVault/
/// MockERC20) + a DRILL-READY governed-calldata account (timelockDelay = 0 so the
/// deployed adversarial drill can grant + probe in one session). owner == sessionKey ==
/// the broadcasting ops key so the drill can both grant (owner) and call (session).
/// Records all addresses (untruncated) for DEPLOYMENTS.md + the drill.
contract DeployStageD is Script {
    function run() external {
        address ops = msg.sender;
        vm.startBroadcast();
        LeashAccountV4Factory factory = new LeashAccountV4Factory();
        MockERC20 usd = new MockERC20("Stage-D Test USD", "TUSD-D", 6);
        MockRouter router = new MockRouter();
        MockVault vault = new MockVault(IERC20(address(usd)));

        LeashAccountV4.Policy memory pol = LeashAccountV4.Policy({
            perTransferCap: 1 ether,
            windowCap: 10 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 365 days)
        });
        address[] memory allow = new address[](1);
        allow[0] = ops;
        // timelockDelay = 0 so the drill grants apply instantly (testnet drill only).
        address acct = factory.createAccountV4(
            ops, ops, ops, pol, allow, 0, address(usd), LeashAccountV4.TokenPolicy(1_000e6, 5_000e6)
        );
        usd.mint(acct, 1_000e6);

        // grant: approve(usd → router) within a cumulative budget, so the drill can prove
        // a HAPPY governed approve lands and MALICIOUS shapes revert.
        LeashAccountV4 a = LeashAccountV4(payable(acct));
        a.proposeSpendBudget(address(usd), 500e6);
        a.applySpendBudget();
        address[] memory sp = new address[](1);
        sp[0] = address(router);
        a.proposeCallRule(address(usd), 0x095ea7b3, 0, sp, 200e6, 400e6, bytes32(0));
        a.applyCallRule();
        vm.stopBroadcast();

        console.log("LeashAccountV4Factory:", address(factory));
        console.log("MockERC20 (TUSD-D):", address(usd));
        console.log("MockRouter:", address(router));
        console.log("MockVault:", address(vault));
        console.log("DrillAccount (v4):", acct);
        console.log("Router (granted spender):", address(router));
    }
}
