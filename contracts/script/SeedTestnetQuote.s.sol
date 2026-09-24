// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {TestnetStockToken, TestnetPriceFeed} from "../src/testnet/TestnetAssets.sol";

/// Deploy and register the venue's quote asset on testnet.
///
/// Robinhood Chain testnet has no USDG, and `EligibleRegistry.usdg` is an immutable set to the
/// mainnet address — so the `STABLE` kind is unreachable here and nothing could fund a buy. This
/// registers a six-decimal stand-in under the `STOCK` kind, which is the only kind whose probe a
/// testnet token can satisfy.
///
/// Six decimals deliberately: USDG is six and the equities are eighteen, and the quote leg's
/// whole job is converting between them. A stand-in with matching decimals would let a decimal
/// bug through unnoticed.
///
/// The asset is registered but **never passed to `commitWindow`**: the crossing proof refuses a
/// window that prices the asset it also pays out in, or a seller's "quote" would be units of the
/// very asset being traded.
///
///   forge script script/SeedTestnetQuote.s.sol --rpc-url $RPC --broadcast
contract SeedTestnetQuote is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        EligibleRegistry registry = EligibleRegistry(vm.envAddress("ARCLITE_REGISTRY"));

        require(block.chainid != 4663, "never seed mainnet");
        console.log("chain    ", block.chainid);
        console.log("registry ", address(registry));

        vm.startBroadcast(pk);

        TestnetStockToken token = new TestnetStockToken("ArcLite Test USDG", "tUSDG", 1e18, 6);
        // Pinned at one dollar. A quote asset that moved against the dollar would make every
        // expected number in the pipeline a moving target for no test value.
        TestnetPriceFeed feed = new TestnetPriceFeed("Robinhood tUSDG / USD", 100_000_000);

        uint16 assetId = registry.registerAsset(
            address(token), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, 86_400, 0
        );

        // Enough to fund a meaningful buy without a second transaction. 100,000 tUSDG at six
        // decimals — roughly 450 tNVDA at the seeded reference.
        token.mint(deployer, 100_000_000000);

        vm.stopBroadcast();

        require(token.decimals() == 6, "the quote asset must be six decimals");
        require(registry.assetIdOf(address(token)) == assetId, "registration did not stick");

        console.log("");
        console.log("  tUSDG");
        console.log("    assetId ", assetId);
        console.log("    token   ", address(token));
        console.log("    feed    ", address(feed));
        console.log("");
        console.log("Set ARCLITE_QUOTE_ASSET_ID to the assetId above before deploying the pool.");
    }
}
