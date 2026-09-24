// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVerifier} from "../interfaces/IVerifier.sol";

/// @dev Test double standing in for a generated UltraHonk verifier until the circuits exist.
///      It lets the pool's *invariants* be tested now — that unshield stays open, that no admin
///      path moves tokens, that nullifiers cannot repeat — without waiting on proving.
///      Never deployed: `RwaDarkPool` takes verifier addresses at construction and governance
///      swaps in the real ones.
contract MockVerifier is IVerifier {
    bool public shouldVerify = true;
    bytes32 public lastPublicInputsHash;

    function setShouldVerify(bool v) external {
        shouldVerify = v;
    }

    function verify(bytes calldata, bytes32[] calldata publicInputs) external view returns (bool) {
        // Record what was asserted so tests can check the pool bound the right values into the
        // proof's public inputs rather than merely calling *a* verifier.
        return shouldVerify && publicInputs.length > 0;
    }
}

/// @dev Same, but records inputs for inspection. Separate so `verify` can stay `view` above.
contract RecordingVerifier is IVerifier {
    bool public shouldVerify = true;
    bytes32[] private _last;

    function setShouldVerify(bool v) external {
        shouldVerify = v;
    }

    function verify(bytes calldata, bytes32[] calldata publicInputs) external view returns (bool) {
        return shouldVerify && publicInputs.length > 0;
    }

    function record(bytes32[] calldata publicInputs) external {
        delete _last;
        for (uint256 i = 0; i < publicInputs.length; ++i) {
            _last.push(publicInputs[i]);
        }
    }

    function lastLength() external view returns (uint256) {
        return _last.length;
    }

    function lastAt(uint256 i) external view returns (bytes32) {
        return _last[i];
    }
}
