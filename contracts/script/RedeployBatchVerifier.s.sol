// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {HonkVerifier as BatchCrossVerifier} from "../src/verifiers/BatchCrossVerifier.sol";

/// Deploy the regenerated `BatchCrossVerifier` and point the pool at it.
///
/// `RwaDarkPool` is immutable by design, but the verifiers are not: a circuit change produces a
/// new verification key, and a proof from the new circuit is rejected by the old verifier with
/// `SumcheckFailed` — which reads like a bad proof rather than a stale address. `setVerifiers` is
/// the one supported way for the pool to follow a circuit, and it is additive: the old verifier
/// stays deployed, so a proof already in flight against it can still be checked.
///
/// A forge script rather than a viem one because the generated verifier links two libraries
/// (`RelationsLib`, `ZKTranscriptLib`). Deploying it from the raw artifact sends unlinked
/// bytecode with `__$...$__` placeholders still in it, and the node rejects that as an invalid
/// byte sequence — a message that says nothing about a missing library.
///
///   forge script script/RedeployBatchVerifier.s.sol --rpc-url $RPC --broadcast
contract RedeployBatchVerifier is Script {
    function run() external {
        address pool = vm.envAddress("POOL");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        RwaDarkPool p = RwaDarkPool(pool);
        // `setVerifiers` takes the whole set, so the two being kept have to be carried over
        // verbatim. A zero address for either would disable a gate silently.
        IVerifier shieldV = p.shieldVerifier();
        IVerifier unshieldV = p.unshieldVerifier();
        console.log("pool         ", pool);
        console.log("shield       ", address(shieldV));
        console.log("unshield     ", address(unshieldV));
        console.log("batch (old)  ", address(p.batchVerifier()));

        vm.startBroadcast(pk);
        BatchCrossVerifier batchV = new BatchCrossVerifier();
        p.setVerifiers(shieldV, unshieldV, IVerifier(address(batchV)));
        vm.stopBroadcast();

        // Read it back rather than trusting the broadcast: a successful transaction that set
        // something else is the failure this check exists for.
        require(address(p.batchVerifier()) == address(batchV), "the pool did not take the verifier");
        console.log("batch (new)  ", address(batchV));
    }
}
