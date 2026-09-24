// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";

/// @notice Registers the eligible universe.
///
/// Deliberately takes explicit token/feed pairs rather than discovering them: registration is a
/// governance act, and the registry's probe is defence-in-depth against a mistake here, not a
/// substitute for verifying the address against the RHC registry off-chain first.
///
///   REGISTRY=0x... ASSETS="NVDA:0xtoken:0xfeed,AAPL:0x...:0x..." \
///   forge script script/RegisterAssets.s.sol --rpc-url $RPC --broadcast --slow
contract RegisterAssets is Script {
    /// Chainlink equity feeds on RHC update at most daily, with a 0.5% deviation trigger. The
    /// bound here is the hard ceiling the contract enforces; the scheduler applies a tighter,
    /// session-aware bound off-chain and declines to open windows when the market is shut.
    uint32 constant MAX_STALENESS = 3 days;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        EligibleRegistry registry = EligibleRegistry(vm.envAddress("REGISTRY"));

        address[] memory tokens = vm.envAddress("TOKENS", ",");
        address[] memory feeds = vm.envAddress("FEEDS", ",");
        require(tokens.length == feeds.length, "TOKENS and FEEDS must be the same length");
        require(tokens.length > 0, "nothing to register");

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < tokens.length; ++i) {
            // A failure here is informative rather than fatal: one unpriceable or non-RWA asset
            // should not abandon the rest of the batch.
            try registry.registerAsset(
                tokens[i], feeds[i], address(0), EligibleRegistry.AssetKind.STOCK, false, MAX_STALENESS, 0
            ) returns (uint16 id) {
                console.log("registered", tokens[i], "as assetId", id);
            } catch Error(string memory reason) {
                console.log("SKIPPED", tokens[i], reason);
            } catch (bytes memory) {
                console.log("SKIPPED", tokens[i], "(rejected by the registry probe)");
            }
        }
        vm.stopBroadcast();

        console.log("");
        console.log("registered count", registry.registeredCount());
    }
}
