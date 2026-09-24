// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {TapeRegistry, IPoolWindows} from "../src/TapeRegistry.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {HonkVerifier as BatchCrossVerifier} from "../src/verifiers/BatchCrossVerifier.sol";

/// @notice Deploy the delayed tape, and the batch verifier the changed circuit needs.
///
/// The `batch_cross` tape leaf changed — it used to chain the receipts root, which would have
/// meant a tape reveal exposing the order book — so the verification key changed with it and the
/// old verifier can no longer accept a valid proof. Swapping it is a governance call rather than
/// a redeploy, which is exactly why verifier addresses are settable.
contract DeployTape is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        RwaDarkPool pool = RwaDarkPool(vm.envAddress("ARCLITE_POOL"));

        // Testnet values. Production is 15 minutes; a quarter-hour per demonstration makes the
        // flow untestable, and the delay is a policy dial rather than a safety property — the
        // safety comes from the commitment being fixed at proving time.
        uint64 delay = uint64(vm.envOr("ARCLITE_TAPE_DELAY", uint256(60)));
        uint16 k = uint16(vm.envOr("ARCLITE_K_ANONYMITY", uint256(3)));

        vm.startBroadcast(pk);

        BatchCrossVerifier batchV = new BatchCrossVerifier();
        TapeRegistry tape = new TapeRegistry(IPoolWindows(address(pool)), delay, k);
        pool.setVerifiers(pool.shieldVerifier(), pool.unshieldVerifier(), IVerifier(address(batchV)));

        vm.stopBroadcast();

        console.log("BatchCrossVerifier", address(batchV));
        console.log("TapeRegistry      ", address(tape));
        console.log("  tapeDelay       ", tape.tapeDelay());
        console.log("  kAnonymity      ", tape.kAnonymity());

        require(address(pool.batchVerifier()) == address(batchV), "pool did not take the new verifier");
        require(address(tape.pool()) == address(pool), "tape points at the wrong pool");
        require(tape.tapeDelay() > 0, "a zero delay makes this a real-time feed");
        console.log("wiring verified");
    }
}
