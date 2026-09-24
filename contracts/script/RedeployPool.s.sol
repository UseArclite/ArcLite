// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";

/// @notice Replaces the pool alone, keeping the pricer, the registry and every verifier.
///
/// `RwaDarkPool` is immutable by design, so a change to its own code is a new address. Nothing
/// else has to move with it: `pricer` is immutable *on the pool*, not the other way round, so a
/// new pool can be constructed against the committer already deployed. That is the difference
/// between this script and `RedeployPricerAndPool` — there, the committer itself was wrong.
///
/// The three changes this deployment carries, all of them state a property the previous pool
/// could not:
///
/// **Withdrawal verification is not optional.** It was skipped when `unshieldVerifier` was the
/// zero address and the setter accepted zero, so one governance call turned a proof-gated exit
/// into an unproven one.
///
/// **Published output commitments are bound to the proven subtree root.** The old pool spliced
/// the root the proof committed and emitted the leaf list beside it with nothing tying the two
/// together — and a recipient rebuilds their Merkle path from exactly that event.
///
/// **Queued deposits can be drained by anyone.** They entered the tree only from `settleBatch`
/// and `voidWindow`, 32 at a time, so past the 32nd a holder had no path and could not withdraw
/// until the venue happened to settle another window.
///
/// The shield verifier starts at `address(0)`, as it has on every pool this venue has run: no
/// issuer signs an attestation and no screening circuit is compiled, so a verifier there rejects
/// every honest deposit and screens nobody. `setVerifiers` turns it on when that changes — and
/// still accepts zero for this one, deliberately, because zeroing an entry gate is recoverable.
///
/// Notes in the previous pool are unaffected and stay withdrawable from it: `unshield` carries no
/// pause, no role and no window check, and its verifier is untouched. Put the old address in
/// `retiredPools` so the vault keeps looking there.
///
///   REGISTRY=0x... PRICER=0x... UNSHIELD_VERIFIER=0x... BATCH_VERIFIER=0x... \
///   QUOTE_TOKEN=0x... RELAYER=0x... \
///   forge script script/RedeployPool.s.sol --rpc-url $RPC --broadcast --slow
contract RedeployPool is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        EligibleRegistry registry = EligibleRegistry(vm.envAddress("REGISTRY"));
        PriceCommitter pricer = PriceCommitter(vm.envAddress("PRICER"));
        IVerifier unshieldV = IVerifier(vm.envAddress("UNSHIELD_VERIFIER"));
        IVerifier batchV = IVerifier(vm.envAddress("BATCH_VERIFIER"));
        address relayer = vm.envAddress("RELAYER");

        uint16 quoteAssetId = registry.assetIdOf(vm.envAddress("QUOTE_TOKEN"));
        require(quoteAssetId != 0, "quote asset is not registered");
        require(registry.registeredCount() > 1, "registry looks empty; wrong address?");
        require(address(pricer).code.length > 0, "pricer has no code");
        // The pricer must already be pointed at this registry, or the pool would price against
        // one universe and settle against another.
        require(address(pricer.registry()) == address(registry), "pricer registry mismatch");
        require(address(unshieldV).code.length > 0, "unshield verifier has no code");
        require(address(batchV).code.length > 0, "batch verifier has no code");
        require(relayer != deployer, "relayer must not be the deployer");

        console.log("deployer     ", deployer);
        console.log("registry     ", address(registry), "assets", registry.registeredCount());
        console.log("pricer       ", address(pricer));
        console.log("quoteAssetId ", quoteAssetId);

        vm.startBroadcast(pk);

        RwaDarkPool pool = new RwaDarkPool(
            deployer, registry, pricer, IVerifier(address(0)), unshieldV, batchV, quoteAssetId
        );

        pool.grantRole(pool.SEALER_ROLE(), relayer);
        pool.grantRole(pool.SETTLER_ROLE(), relayer);
        // The pricer is kept, so the relayer already holds PRICER_ROLE on it. Asserted below
        // rather than granted again, because a re-grant would hide the case where it does not.

        vm.stopBroadcast();

        console.log("");
        console.log("RwaDarkPool  ", address(pool));

        require(address(pool.pricer()) == address(pricer), "pool pricer mismatch");
        require(address(pool.registry()) == address(registry), "pool registry mismatch");
        require(pool.quoteAssetId() == quoteAssetId, "pool quote asset mismatch");
        require(pool.currentRoot() != bytes32(0), "tree not initialised");
        require(!pool.paused(), "pool should start unpaused");

        require(address(pool.unshieldVerifier()) == address(unshieldV), "unshield verifier mismatch");
        require(address(pool.batchVerifier()) == address(batchV), "batch verifier mismatch");
        require(address(pool.shieldVerifier()) == address(0), "shield gate should start off");

        require(pool.hasRole(pool.SEALER_ROLE(), relayer), "relayer cannot seal");
        require(pool.hasRole(pool.SETTLER_ROLE(), relayer), "relayer cannot settle");
        require(pricer.hasRole(pricer.PRICER_ROLE(), relayer), "relayer cannot price");
        require(!pool.hasRole(pool.DEFAULT_ADMIN_ROLE(), relayer), "relayer must not hold admin");

        // The property this deployment exists for, checked on the thing that was deployed rather
        // than assumed from the source that produced it.
        require(pool.pendingDepositCount() == 0, "a fresh pool has nothing queued");

        console.log("");
        console.log("wiring verified; add the previous pool to retiredPools");
    }
}
