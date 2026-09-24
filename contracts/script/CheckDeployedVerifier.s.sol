// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";

/// Read-only: does the verifier the pool now points at actually accept the current proof?
///
/// A bytecode comparison cannot answer this on its own — the generated verifier links two
/// libraries, so the deployed code legitimately differs from the local artifact. What settles it
/// is behaviour: the honest proof verifies against the new address, the same bytes are rejected
/// by the old one, and a perturbed public input is rejected by both.
contract CheckDeployedVerifier is Script {
    function run() external view {
        IVerifier newV = IVerifier(vm.envAddress("NEW_VERIFIER"));
        IVerifier oldV = IVerifier(vm.envAddress("OLD_VERIFIER"));

        bytes memory proof = vm.readFileBinary("test/fixtures/batch_cross.proof");
        bytes memory raw = vm.readFileBinary("test/fixtures/batch_cross.public_inputs");
        bytes32[] memory inputs = new bytes32[](raw.length / 32);
        for (uint256 i = 0; i < inputs.length; ++i) {
            bytes32 w;
            uint256 o = 32 + i * 32;
            assembly { w := mload(add(raw, o)) }
            inputs[i] = w;
        }
        console.log("public inputs", inputs.length);

        try newV.verify(proof, inputs) returns (bool ok) {
            console.log("new verifier, honest proof :", ok ? "VERIFIES" : "rejected");
        } catch { console.log("new verifier, honest proof : reverted"); }

        try oldV.verify(proof, inputs) returns (bool ok) {
            console.log("old verifier, honest proof :", ok ? "verifies" : "rejected");
        } catch { console.log("old verifier, honest proof : reverted (expected)"); }

        inputs[5] = bytes32(uint256(inputs[5]) + 1);
        try newV.verify(proof, inputs) returns (bool ok) {
            console.log("new verifier, tampered     :", ok ? "VERIFIES (BAD)" : "rejected");
        } catch { console.log("new verifier, tampered     : reverted (expected)"); }
    }
}
