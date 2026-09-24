// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {EventCalendar} from "../src/EventCalendar.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";

/// @notice Replaces the price committer, and therefore the pool, keeping everything else.
///
/// `RwaDarkPool.pricer` is immutable, so a corrected `PriceCommitter` cannot be swapped in —
/// the pool has to be new. Nothing else does: the registry with its 36 registered assets, the
/// event calendar, and the three generated verifiers are all still correct and stay exactly
/// where they are. That turns a 42M-gas redeploy into roughly 6M.
///
/// Two things change deliberately.
///
/// **The multiplier guard is fixed.** The old committer deferred any asset whose `effectiveAt`
/// was non-zero, which is every asset that has ever been restated — 13 of 35 on mainnet,
/// permanently, including NVDA and SPY.
///
/// **The shield verifier starts at `address(0)`.** The first pool was deployed with a real one
/// while no screening circuit was compiled, no attestation issuer existed, and the browser sent
/// an empty proof, so every deposit reverted. Setting it to zero here is not a change of policy;
/// it is the policy the venue has always actually run under, stated at deployment instead of
/// patched afterwards. When an issuer exists, `setVerifiers` turns it back on.
///
/// Notes shielded into the old pool are unaffected and stay withdrawable from it forever:
/// `unshield` carries no pause, no role and no window check, and the old pool's verifier is
/// untouched. The address belongs in `retiredPools` so the vault keeps looking there.
///
///   REGISTRY=0x... CALENDAR=0x... UNSHIELD_VERIFIER=0x... BATCH_VERIFIER=0x... \
///   RELAYER=0x... DEPLOYER_PRIVATE_KEY=... \
///   forge script script/RedeployPricerAndPool.s.sol --rpc-url $RPC --broadcast --slow
contract RedeployPricerAndPool is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        EligibleRegistry registry = EligibleRegistry(vm.envAddress("REGISTRY"));
        EventCalendar calendar = EventCalendar(vm.envAddress("CALENDAR"));
        IVerifier unshieldV = IVerifier(vm.envAddress("UNSHIELD_VERIFIER"));
        IVerifier batchV = IVerifier(vm.envAddress("BATCH_VERIFIER"));
        address relayer = vm.envAddress("RELAYER");

        uint16 quoteAssetId = registry.assetIdOf(vm.envAddress("QUOTE_TOKEN"));
        require(quoteAssetId != 0, "quote asset is not registered");
        require(registry.registeredCount() > 1, "registry looks empty; wrong address?");
        require(address(unshieldV).code.length > 0, "unshield verifier has no code");
        require(address(batchV).code.length > 0, "batch verifier has no code");
        require(relayer != deployer, "relayer must not be the deployer");

        console.log("deployer     ", deployer);
        console.log("registry     ", address(registry), "assets", registry.registeredCount());
        console.log("quoteAssetId ", quoteAssetId);

        vm.startBroadcast(pk);

        PriceCommitter pricer = new PriceCommitter(deployer, registry, calendar);

        RwaDarkPool pool = new RwaDarkPool(
            deployer,
            registry,
            pricer,
            // No screening gate: there is no issuer to sign an attestation and no circuit
            // compiled to prove one. A verifier here rejects every honest deposit and screens
            // nobody, which is what the first deployment did.
            IVerifier(address(0)),
            unshieldV,
            batchV,
            quoteAssetId
        );

        pricer.grantRole(pricer.PRICER_ROLE(), deployer);
        pricer.grantRole(pricer.PRICER_ROLE(), relayer);
        pool.grantRole(pool.SEALER_ROLE(), relayer);
        pool.grantRole(pool.SETTLER_ROLE(), relayer);
        pricer.heartbeat();

        vm.stopBroadcast();

        console.log("");
        console.log("PriceCommitter ", address(pricer));
        console.log("RwaDarkPool    ", address(pool));

        require(address(pool.pricer()) == address(pricer), "pool pricer mismatch");
        require(address(pool.registry()) == address(registry), "pool registry mismatch");
        require(address(pricer.registry()) == address(registry), "pricer registry mismatch");
        require(address(pricer.eventCalendar()) == address(calendar), "pricer calendar mismatch");
        require(pool.quoteAssetId() == quoteAssetId, "pool quote asset mismatch");
        require(pool.currentRoot() != bytes32(0), "tree not initialised");
        require(!pool.paused(), "pool should start unpaused");

        // The gate that must never be optional, and the one that would not revert to tell you.
        require(address(pool.unshieldVerifier()) == address(unshieldV), "unshield verifier mismatch");
        require(address(pool.batchVerifier()) == address(batchV), "batch verifier mismatch");
        require(address(pool.shieldVerifier()) == address(0), "shield gate should start off");

        require(pool.hasRole(pool.SEALER_ROLE(), relayer), "relayer cannot seal");
        require(pool.hasRole(pool.SETTLER_ROLE(), relayer), "relayer cannot settle");
        require(pricer.hasRole(pricer.PRICER_ROLE(), relayer), "relayer cannot price");
        require(!pool.hasRole(pool.DEFAULT_ADMIN_ROLE(), relayer), "relayer must not hold admin");

        console.log("");
        console.log("wiring verified; add the previous pool to retiredPools");
    }
}
