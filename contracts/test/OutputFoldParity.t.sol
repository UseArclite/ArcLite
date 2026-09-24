// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Poseidon2} from "../src/libraries/Poseidon2.sol";

/// @title The contract's output fold against the circuit's, on real data
/// @notice `settleBatch` recomputes the output subtree root from the published commitments and
///         refuses a settlement whose leaves do not produce the root the proof committed. That
///         check is only safe if the two folds agree exactly — otherwise it rejects every honest
///         settlement, which is a total halt rather than a subtle bug.
///
///         The settlement tests cannot establish this. They use a mock verifier and build the
///         expected root with the same Solidity fold they are checking, so they agree with
///         themselves by construction. This reads the 32 leaves out of a real `batch_cross`
///         witness and the root out of the real proof's public inputs, and folds them with the
///         contract's implementation.
///
///         Regenerate the fixtures alongside the proof:
///           bun scripts/build-batch-witness.mjs
///           cd circuits && nargo execute --package batch_cross batch_witness
///           bb prove -b ./target/batch_cross.json -w ./target/batch_witness.gz -o ./target \
///             --oracle_hash keccak
contract OutputFoldParityTest is Test {
    /// Byte-for-byte the fold in `RwaDarkPool._subtreeRootOf`.
    function _fold(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            level[i] = leaves[i];
        }
        while (n > 1) {
            for (uint256 i = 0; i < n / 2; ++i) {
                level[i] = bytes32(Poseidon2.hash2(uint256(level[2 * i]), uint256(level[2 * i + 1])));
            }
            n /= 2;
        }
        return level[0];
    }

    function test_ContractFoldReproducesTheProvenRoot() public view {
        string[] memory raw =
            vm.split(vm.trim(vm.readFile("test/fixtures/batch_cross.out_commitments")), "\n");
        assertEq(raw.length, 32, "the circuit always proves 32 outputs");

        bytes32[] memory leaves = new bytes32[](32);
        for (uint256 i = 0; i < 32; ++i) {
            leaves[i] = bytes32(vm.parseUint(vm.trim(raw[i])));
        }

        bytes32 proven =
            vm.parseBytes32(vm.trim(vm.readFile("test/fixtures/batch_cross.outputs_subtree_root")));
        assertEq(_fold(leaves), proven, "the contract would reject every honest settlement");
    }

    /// @dev And the other direction: the check has to actually bite. A leaf altered anywhere in
    ///      the set must change the root, or binding the commitments would prove nothing.
    function test_AnyAlteredLeafChangesTheRoot() public view {
        string[] memory raw =
            vm.split(vm.trim(vm.readFile("test/fixtures/batch_cross.out_commitments")), "\n");
        bytes32[] memory leaves = new bytes32[](32);
        for (uint256 i = 0; i < 32; ++i) {
            leaves[i] = bytes32(vm.parseUint(vm.trim(raw[i])));
        }
        bytes32 proven = _fold(leaves);

        // Including the zero padding slots, which a settler would otherwise be free to fill.
        for (uint256 i = 0; i < 32; ++i) {
            bytes32 kept = leaves[i];
            leaves[i] = bytes32(uint256(kept) + 1);
            assertTrue(_fold(leaves) != proven, "an altered leaf left the root unchanged");
            leaves[i] = kept;
        }
    }
}
