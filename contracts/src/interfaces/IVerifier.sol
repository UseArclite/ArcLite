// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The surface `bb write_solidity_verifier` emits for an UltraHonk circuit.
/// @dev    Generated verifiers are `view` and revert or return false on an invalid proof.
///         Public inputs are field elements in the circuit's declared order; a mismatch in
///         count fails with PUBLIC_INPUT_COUNT_INVALID rather than silently verifying.
interface IVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
