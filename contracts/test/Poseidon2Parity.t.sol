// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Poseidon2} from "../src/libraries/Poseidon2.sol";

/// @notice Week-1 check #3. Solidity<->Noir Poseidon2 parity is fund-loss-class: a mismatch
///         yields a commitment tree the circuit can prove against but the pool computes
///         differently. These vectors come from `circuits/vectors`, executed by nargo against
///         the same blackbox permutation bb runs, so they are ground truth and not a restatement
///         of this implementation.
///
///         Regenerate with:
///           cd circuits && nargo execute --package vectors out
contract Poseidon2ParityTest is Test {
    function test_Permute_Zeros() public pure {
        uint256[4] memory s = [uint256(0), 0, 0, 0];
        uint256[4] memory r = Poseidon2.permute(s);
        assertEq(r[0], 0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e, "permute([0,0,0,0])[0]");
    }

    function test_Permute_Ramp() public pure {
        uint256[4] memory s = [uint256(1), 2, 3, 4];
        uint256[4] memory r = Poseidon2.permute(s);
        assertEq(r[0], 0x224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1, "permute([1,2,3,4])[0]");
        assertEq(r[3], 0x16c877b5b9c04d873218804ccbf65d0eeb12db447f66c9ca26fec380055df7e9, "permute([1,2,3,4])[3]");
    }

    function test_Hash_OneElement() public pure {
        uint256[] memory a = new uint256[](1);
        a[0] = 1;
        assertEq(Poseidon2.hash(a), 0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373);
    }

    function test_Hash_TwoElements() public pure {
        assertEq(Poseidon2.hash2(1, 2), 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383);
    }

    /// @dev The boundary case: 3 elements exactly fill RATE, so Noir skips the final
    ///      permutation. A port that permutes unconditionally passes every other test here
    ///      and still computes wrong roots. Do not delete this one.
    function test_Hash_ThreeElements_ExactChunk() public pure {
        uint256[] memory a = new uint256[](3);
        (a[0], a[1], a[2]) = (1, 2, 3);
        assertEq(Poseidon2.hash(a), 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8);
    }

    function test_Hash_FourElements_SpansChunks() public pure {
        uint256[] memory a = new uint256[](4);
        (a[0], a[1], a[2], a[3]) = (1, 2, 3, 4);
        assertEq(Poseidon2.hash(a), 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9);
    }

    function test_Hash_Zeros() public pure {
        assertEq(Poseidon2.hash2(0, 0), 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1);
    }
}
