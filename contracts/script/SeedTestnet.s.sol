// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {TestnetPriceFeed, TestnetStockToken} from "../src/testnet/TestnetAssets.sol";

/// @notice Give the deployed testnet venue an asset universe.
///
/// Robinhood Chain testnet has no tokenized equities and no Chainlink feeds, so the registry has
/// nothing it can legitimately accept and nothing can trade. This deploys stand-ins carrying the
/// exact surface the registry probes and registers them through the ordinary path — no bypass,
/// no relaxed check. `TestnetStockToken` and `TestnetPriceFeed` refuse to deploy on mainnet.
///
/// Prices and multipliers are the live mainnet values from
/// `docs/week1-check1-transfer-restrictions.md`, so a number on the testnet dashboard is the
/// number the real asset had — which makes a wrong one visible rather than plausible.
///
///   forge script script/SeedTestnet.s.sol --rpc-url $RPC --broadcast --slow
contract SeedTestnet is Script {
    struct Seed {
        string name;
        string symbol;
        int256 answer8; // 8-decimal feed answer, as Chainlink reports
        uint256 uiMultiplier; // 1e18-scaled
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        EligibleRegistry registry = EligibleRegistry(vm.envAddress("ARCLITE_REGISTRY"));

        // NVDA is first so it takes assetId 1 — the id the committed `unshield` proof fixture was
        // generated against. Changing this order breaks the end-to-end withdrawal test.
        Seed[3] memory seeds = [
            Seed("ArcLite Test NVDA", "tNVDA", 22244729849, 1_000_775_159_164_630_595),
            Seed("ArcLite Test AAPL", "tAAPL", 33538000000, 1_000_566_080_061_092_436),
            Seed("ArcLite Test SPY", "tSPY", 76155000000, 1_001_717_991_187_472_003)
        ];

        console.log("chain    ", block.chainid);
        console.log("deployer ", deployer);
        console.log("registry ", address(registry));
        require(block.chainid != 4663, "never seed mainnet");

        vm.startBroadcast(pk);

        for (uint256 i = 0; i < seeds.length; i++) {
            Seed memory s = seeds[i];

            TestnetStockToken token = new TestnetStockToken(s.name, s.symbol, s.uiMultiplier, 18);
            TestnetPriceFeed feed = new TestnetPriceFeed(
                string.concat("Robinhood ", s.symbol, " / USD"), s.answer8
            );

            // A day's staleness bound: equity feeds legitimately stop updating when markets
            // close, and a tighter bound would defer every asset all weekend.
            uint16 assetId = registry.registerAsset(
                address(token),
                address(feed),
                address(0),
                EligibleRegistry.AssetKind.STOCK,
                false,
                86_400,
                0
            );

            // Seed the deployer so there is something to shield without a second transaction.
            token.mint(deployer, 100_000e18);

            console.log("");
            console.log(string.concat("  ", s.symbol));
            console.log("    assetId ", assetId);
            console.log("    token   ", address(token));
            console.log("    feed    ", address(feed));
        }

        vm.stopBroadcast();

        // Assert the universe is actually usable, rather than merely written. Registration
        // having returned an id is not the same as the asset being tradable — the registry only
        // accepts what it can price, and `isActive` is the condition every other check funnels
        // through.
        console.log("");
        for (uint16 id = 1; id <= seeds.length; id++) {
            EligibleRegistry.Asset memory a = registry.asset(id);
            require(a.token != address(0), "asset missing");
            require(a.feed != address(0), "asset has no feed");
            require(registry.isActive(a.token), "asset registered but not active");
            require(a.decimals == 18, "unexpected token decimals");
            console.log("  assetId", id, "active");
        }
        console.log("");
        console.log("seeded");
    }
}
