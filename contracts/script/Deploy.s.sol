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
import {MockAggregatorV3} from "../src/MockAggregatorV3.sol";
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

        // grant: approve(usd → router|vault) within a cumulative budget, so the drill can
        // prove a HAPPY governed approve lands and MALICIOUS shapes revert. Vault is a
        // second allowed spender so the deposit sub-drill can `approve(vault) → deposit`.
        // Per-token budgets get generous headroom (5_000e6) so all three drills
        // (adversarial + deposit + JIT) run in one session without tripping the
        // cumulative-spend cap; per-call/window caps stay at the asserted 200e6/400e6.
        LeashAccountV4 a = LeashAccountV4(payable(acct));
        a.proposeSpendBudget(address(usd), 5_000e6);
        a.applySpendBudget();
        a.proposeSpendBudget(address(vault), 5_000e6);
        a.applySpendBudget();
        address[] memory sp = new address[](2);
        sp[0] = address(router);
        sp[1] = address(vault);
        a.proposeCallRule(address(usd), 0x095ea7b3, 0, sp, 200e6, 400e6, bytes32(0));
        a.applyCallRule();
        // deposit rule on the curated vault: recipientMode 0 (receiver must == self),
        // no spenders, assets charged vs the per-call cap + the vault-keyed budget. Proves
        // the FIX-1 on-chain deposit decoder: a hijacked key can't redirect minted shares.
        address[] memory noSpenders = new address[](0);
        a.proposeCallRule(address(vault), 0x6e553f65, 0, noSpenders, 200e6, 400e6, bytes32(0));
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

/// RH slice (Arbitrum Open House) — the oracle-aware governed-stock-trading deploy
/// for Robinhood Chain testnet (46630), rung 3: faithful mocks, real interfaces.
/// Deploys AgentRegistry + LeashAccountV4Factory + sUSD/sTSLA (both 18dp, clean
/// implied-price math) + MockRouter + MockAggregatorV3 (8dp, TSLA = $100), then a
/// DRILL-READY account (owner == session == ops, timelockDelay = 0) granted:
///   - approve(sUSD → router) within a cumulative budget,
///   - swap(router) governed, and
///   - a PRICE BAND on the swap rule (feed = the mock, asset = sTSLA, 5% band,
///     1h staleness) — the hero: a premium or stale/invalid/down feed REVERTS.
/// The agent (session key) performs approve → swap off-chain; the wall enforces.
/// Blockscout-verify every address. Records all addresses (untruncated).
contract DeployRobinhood is Script {
    bytes4 constant SEL_APPROVE = 0x095ea7b3;
    bytes4 constant SEL_SWAP = 0x9908fc8b; // swap(address,address,uint256,uint256,address,uint256)

    function run() external {
        address ops = msg.sender;
        vm.startBroadcast();
        AgentRegistry registry = new AgentRegistry();
        LeashAccountV4Factory factory = new LeashAccountV4Factory();
        MockERC20 susd = new MockERC20("Synthetic USD (LEASH RH)", "sUSD", 18);
        MockERC20 stsla = new MockERC20("Synthetic TSLA (LEASH RH)", "sTSLA", 18);
        MockRouter router = new MockRouter();
        MockAggregatorV3 feed = new MockAggregatorV3(100e8); // TSLA = $100, 8dp

        LeashAccountV4.Policy memory pol = LeashAccountV4.Policy({
            perTransferCap: 1 ether,
            windowCap: 10 ether,
            windowSeconds: 1 hours,
            expiresAt: uint64(block.timestamp + 365 days)
        });
        address[] memory allow = new address[](1);
        allow[0] = ops;
        address acct = factory.createAccountV4(
            ops, ops, ops, pol, allow, 0, address(susd), LeashAccountV4.TokenPolicy(1_000e18, 5_000e18)
        );
        // Fund: account holds sUSD to spend; router holds sTSLA to pay out (1:1 mock).
        susd.mint(acct, 10_000e18);
        stsla.mint(address(router), 10_000e18);

        LeashAccountV4 a = LeashAccountV4(payable(acct));
        // approve(sUSD → router) within a cumulative budget (the enabling leg).
        a.proposeSpendBudget(address(susd), 5_000e18);
        a.applySpendBudget();
        address[] memory sp = new address[](1);
        sp[0] = address(router);
        a.proposeCallRule(address(susd), SEL_APPROVE, 0, sp, 2_000e18, 5_000e18, bytes32(0));
        a.applyCallRule();
        // swap(router) governed (chargeable == 0; token outflow is bounded by approve).
        address[] memory none = new address[](0);
        a.proposeCallRule(address(router), SEL_SWAP, 0, none, type(uint128).max, type(uint128).max, bytes32(0));
        a.applyCallRule();
        // the HERO: a 5% price band on the swap, priced off the mock equity feed.
        a.tightenPriceBand(address(router), SEL_SWAP, address(feed), address(stsla), 500, 1 hours);
        vm.stopBroadcast();

        console.log("AgentRegistry:", address(registry));
        console.log("LeashAccountV4Factory:", address(factory));
        console.log("MockERC20 sUSD (18dp):", address(susd));
        console.log("MockERC20 sTSLA (18dp):", address(stsla));
        console.log("MockRouter:", address(router));
        console.log("MockAggregatorV3 (8dp, TSLA=$100):", address(feed));
        console.log("DrillAccount (v4):", acct);
    }
}
