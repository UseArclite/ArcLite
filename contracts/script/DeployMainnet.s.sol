// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {EventCalendar} from "../src/EventCalendar.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {HonkVerifier as UnshieldVerifier} from "../src/verifiers/UnshieldVerifier.sol";
import {HonkVerifier as ScreeningVerifier} from "../src/verifiers/ScreeningVerifier.sol";
import {HonkVerifier as BatchCrossVerifier} from "../src/verifiers/BatchCrossVerifier.sol";

/// @notice Deploys the venue to Robinhood Chain mainnet, quote asset included.
///
/// `Deploy.s.sol` reads `ARCLITE_QUOTE_ASSET_ID` from the environment and hands it to the pool,
/// where it is immutable. That works on testnet because the quote asset is a stand-in the
/// deployer mints in a separate script, and a wrong id means redeploying contracts nobody has
/// used. On mainnet it is the wrong shape twice over: the id does not exist until USDG has been
/// registered in a registry this very script creates, and an id that is off by one produces a
/// pool that pays sellers in a traded equity — silently, and permanently, because there is no
/// setter.
///
/// So the registration and the deployment happen in one run, and the pool is given the id the
/// registry *returned* rather than an id somebody typed. The equities are registered afterwards
/// with `RegisterAssets.s.sol`; only the quote id is immutable, so only it has to be first.
///
///   DEPLOYER_PRIVATE_KEY=... forge script script/DeployMainnet.s.sol \
///     --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --slow \
///     --verify --verifier blockscout \
///     --verifier-url https://robinhoodchain.blockscout.com/api
///
/// `--slow` is not optional on an Orbit chain: it sends sequentially so nonces cannot race.
contract DeployMainnet is Script {
    /// USDG on RHC mainnet. The single permitted STABLE, hardcoded in the registry by design.
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// USDG/USD. A crypto-category feed, so unlike the equity feeds it updates around the clock
    /// — which is what lets the quote leg be priced on a Sunday.
    address constant USDG_USD_FEED = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;

    /// The quote feed never stops, so its bound can be hours rather than the equities' days.
    uint32 constant QUOTE_MAX_STALENESS = 6 hours;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        // This script hardcodes mainnet addresses. Run on any other chain and the registry would
        // reject them one by one with messages about missing feeds, which reads like a bug in
        // the contracts rather than a script pointed at the wrong RPC.
        require(block.chainid == 4663, "DeployMainnet is for Robinhood Chain mainnet (4663)");

        console.log("chain      ", block.chainid);
        console.log("deployer   ", deployer);
        console.log("balance    ", deployer.balance);
        require(deployer.balance > 0, "deployer has no gas");

        vm.startBroadcast(pk);

        EligibleRegistry registry = new EligibleRegistry(deployer, USDG);
        EventCalendar calendar = new EventCalendar(deployer);
        PriceCommitter pricer = new PriceCommitter(deployer, registry, calendar);

        // Before the pool, because the pool needs the id this returns. `nextAssetId` starts at 1,
        // so USDG becomes asset 1 — but the id is read back rather than assumed, since the whole
        // point of doing it here is to stop anyone assuming it.
        uint16 quoteAssetId = registry.registerAsset(
            USDG, USDG_USD_FEED, address(0), EligibleRegistry.AssetKind.STABLE, false, QUOTE_MAX_STALENESS, 0
        );

        // Each is ~18 KB and these three deployments dominate the gas cost of the run.
        ScreeningVerifier shieldV = new ScreeningVerifier();
        UnshieldVerifier unshieldV = new UnshieldVerifier();
        BatchCrossVerifier batchV = new BatchCrossVerifier();

        RwaDarkPool pool = new RwaDarkPool(
            deployer,
            registry,
            pricer,
            IVerifier(address(shieldV)),
            IVerifier(address(unshieldV)),
            IVerifier(address(batchV)),
            quoteAssetId
        );

        pricer.grantRole(pricer.PRICER_ROLE(), deployer);
        pricer.heartbeat();

        vm.stopBroadcast();

        console.log("");
        console.log("EligibleRegistry ", address(registry));
        console.log("EventCalendar    ", address(calendar));
        console.log("PriceCommitter   ", address(pricer));
        console.log("RwaDarkPool      ", address(pool));
        console.log("  shieldVerifier ", address(shieldV), "(screening)");
        console.log("  unshieldVerifier", address(unshieldV), "(unshield)");
        console.log("  batchVerifier  ", address(batchV), "(batch_cross)");
        console.log("  quoteAssetId   ", quoteAssetId, "(USDG)");

        // Assert the wiring rather than trusting it: these are immutable, so a mismatch means a
        // redeploy and it is far cheaper to learn that now.
        require(address(pool.registry()) == address(registry), "pool registry mismatch");
        require(address(pool.pricer()) == address(pricer), "pool pricer mismatch");
        require(address(pricer.registry()) == address(registry), "pricer registry mismatch");
        require(address(pricer.eventCalendar()) == address(calendar), "pricer calendar mismatch");
        require(registry.usdg() == USDG, "registry usdg mismatch");
        require(pool.currentRoot() != bytes32(0), "tree not initialised");
        require(!pool.paused(), "pool should start unpaused");
        // A verifier deployed as address(0) would silently disable proof checking on unshield,
        // which is the one path that must never be optional.
        require(address(pool.unshieldVerifier()) == address(unshieldV), "unshield verifier mismatch");
        require(address(pool.shieldVerifier()) == address(shieldV), "shield verifier mismatch");
        require(address(pool.batchVerifier()) == address(batchV), "batch verifier mismatch");
        require(address(unshieldV).code.length > 0, "unshield verifier has no code");

        // The one that would be discovered late and expensively. `quoteAssetId` is immutable on
        // the pool; if it does not name USDG, every sale pays out in something else.
        require(pool.quoteAssetId() == quoteAssetId, "pool quote asset mismatch");
        require(registry.assetIdOf(USDG) == quoteAssetId, "quote registration did not stick");
        require(registry.asset(quoteAssetId).decimals == 6, "USDG should be six decimals");

        console.log("");
        console.log("wiring verified");
        console.log("");
        console.log("Next: register the equities with RegisterAssets.s.sol, then grant the");
        console.log("relayer SEALER_ROLE and SETTLER_ROLE on the pool and PRICER_ROLE on the");
        console.log("committer. The deployer keeps admin; the relayer never gets it.");
    }
}
