// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";

/// @notice Redeploy only the pool, reusing the registry, the price committer and the verifiers.
///
/// `RwaDarkPool` is immutable — no proxy, no delegatecall — so a change to it is a new address,
/// not an upgrade. That is the intended trade: nobody can rewrite the contract holding the funds,
/// and the cost is that a fix means a migration. This script is what that costs in practice.
///
/// Everything else is reusable because the pool is the only piece that changed: the registry
/// holds the asset universe, the committer holds the price history, and the verifiers are
/// generated from circuits that did not move.
///
///   ARCLITE_REGISTRY=… ARCLITE_PRICER=… ARCLITE_SHIELD_V=… ARCLITE_UNSHIELD_V=… \
///   ARCLITE_BATCH_V=… forge script script/DeployPool.s.sol --rpc-url $RPC --broadcast --slow
contract DeployPool is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        EligibleRegistry registry = EligibleRegistry(vm.envAddress("ARCLITE_REGISTRY"));
        PriceCommitter pricer = PriceCommitter(vm.envAddress("ARCLITE_PRICER"));
        IVerifier shieldV = IVerifier(vm.envAddress("ARCLITE_SHIELD_V"));
        IVerifier unshieldV = IVerifier(vm.envAddress("ARCLITE_UNSHIELD_V"));
        IVerifier batchV = IVerifier(vm.envAddress("ARCLITE_BATCH_V"));

        console.log("chain   ", block.chainid);
        console.log("deployer", deployer);

        vm.startBroadcast(pk);
        // The quote asset a buy is funded with and a sell is paid in. A public input of every
        // crossing proof, so it is fixed at construction rather than chosen by the settler.
        uint16 quoteId = uint16(vm.envUint("ARCLITE_QUOTE_ASSET_ID"));
        RwaDarkPool pool =
            new RwaDarkPool(deployer, registry, pricer, shieldV, unshieldV, batchV, quoteId);
        vm.stopBroadcast();

        console.log("");
        console.log("RwaDarkPool", address(pool));

        require(address(pool.registry()) == address(registry), "registry mismatch");
        require(address(pool.pricer()) == address(pricer), "pricer mismatch");
        require(address(pool.unshieldVerifier()) == address(unshieldV), "unshield verifier mismatch");
        require(address(pool.batchVerifier()) == address(batchV), "batch verifier mismatch");
        require(pool.quoteAssetId() == quoteId, "quote asset mismatch");
        require(pool.currentRoot() != bytes32(0), "tree not initialised");
        require(pool.nextLeafIndex() == 0, "a fresh pool must start with an empty tree");
        require(pool.openWindowId() == 0, "a fresh pool must have no open window");
        // The reason this redeploy exists. Without it, a window that cannot be settled wedges
        // every later deposit out of the tree, permanently.
        require(pool.settlementDeadline() > 0, "no settlement deadline; voidWindow is unusable");

        console.log("wiring verified; settlementDeadline", pool.settlementDeadline());
    }
}
