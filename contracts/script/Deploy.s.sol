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

/// @notice Deploys the venue to a Robinhood Chain network.
///
/// Order matters: the registry has no dependencies, the calendar none, the price committer needs
/// both, and the pool needs the registry and the committer. Nothing is upgradeable, so a mistake
/// here is a redeploy — which is why the script asserts its own wiring before finishing.
///
///   forge script script/Deploy.s.sol --rpc-url $RHC_TESTNET_RPC --broadcast --slow \
///     --verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api
///
/// `--slow` is not optional on an Orbit chain: it sends sequentially so nonces cannot race.
contract Deploy is Script {
    /// USDG on RHC mainnet. The single permitted STABLE, hardcoded in the registry by design.
    address constant USDG_MAINNET = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        // On testnet USDG may not exist; allow an override so the registry still has a STABLE
        // slot rather than being deployed with address(0), which it refuses.
        address usdg = vm.envOr("USDG_ADDRESS", USDG_MAINNET);

        console.log("chain      ", block.chainid);
        console.log("deployer   ", deployer);
        console.log("balance    ", deployer.balance);
        console.log("usdg       ", usdg);
        require(deployer.balance > 0, "deployer has no gas");

        vm.startBroadcast(pk);

        EligibleRegistry registry = new EligibleRegistry(deployer, usdg);
        EventCalendar calendar = new EventCalendar(deployer);
        PriceCommitter pricer = new PriceCommitter(deployer, registry, calendar);

        // The real generated verifiers. These used to be mocks because the generator's output
        // would not compile; that is fixed (docs/blocker-solidity-verifier-stack.md), and each
        // one is tested against a proof barretenberg produced and verified natively.
        //
        // `shield` takes the screening proof — a different circuit from `unshield`, hence three
        // separate contracts rather than one shared verifier. Each is ~18 KB, so these three
        // deployments dominate the gas cost of the whole script.
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
            uint16(vm.envUint("ARCLITE_QUOTE_ASSET_ID"))
        );

        // The price committer needs the pool to be able to ask it to price windows.
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

        // Assert the wiring rather than trusting it: these are immutable, so a mismatch means a
        // redeploy and it is far cheaper to learn that now.
        require(address(pool.registry()) == address(registry), "pool registry mismatch");
        require(address(pool.pricer()) == address(pricer), "pool pricer mismatch");
        require(address(pricer.registry()) == address(registry), "pricer registry mismatch");
        require(address(pricer.eventCalendar()) == address(calendar), "pricer calendar mismatch");
        require(registry.usdg() == usdg, "registry usdg mismatch");
        require(pool.currentRoot() != bytes32(0), "tree not initialised");
        require(!pool.paused(), "pool should start unpaused");
        // A verifier deployed as address(0) would silently disable proof checking on unshield,
        // which is the one path that must never be optional.
        require(address(pool.unshieldVerifier()) == address(unshieldV), "unshield verifier mismatch");
        require(address(pool.shieldVerifier()) == address(shieldV), "shield verifier mismatch");
        require(address(pool.batchVerifier()) == address(batchV), "batch verifier mismatch");
        require(address(unshieldV).code.length > 0, "unshield verifier has no code");

        console.log("");
        console.log("wiring verified");
    }
}
