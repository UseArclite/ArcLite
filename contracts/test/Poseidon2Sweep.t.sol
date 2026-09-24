// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Poseidon2} from "../src/libraries/Poseidon2.sol";

/// @notice Week-1 check #3, sweep form. 48 vectors: message_size 1..6 across 8 seeds, covering
///         every sponge path — partial chunks, the exact-chunk boundaries at 3 and 6 where Noir
///         skips the final permutation, and multi-chunk absorption.
///
///         Expected values are produced by `circuits/vectors` under nargo, which executes the
///         same barretenberg blackbox the circuit will. They are ground truth, not a restatement
///         of the Solidity port. Seeds are spread across the field rather than being small
///         neighbouring integers, so a constant-ordering or endianness error cannot
///         coincidentally pass.
///
///         Regenerate: cd circuits && nargo execute --package vectors out
contract Poseidon2SweepTest is Test {
    uint256 constant P = Poseidon2.P;
    uint256 constant SEEDS = 8;
    uint256 constant MAXLEN = 6;

    function _expected() internal pure returns (uint256[48] memory) {
        return [
            0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373,
            0x0d1d43fdc97c9ef267ae7e323a2a9ef979d4126f87cfe76c3b3df404751de148,
            0x19e528919e50417eeeaf2ca0d5134ef1fba0820c396ee8d2a7674cdea60fbea0,
            0x24725f9fcb4fef4246a310b5db74f04d72155a05c94c7f120f2acb98fa979592,
            0x11b387d0c1ce0bdc9e4457d34090dc2034511e11f9575e0102f5982da8f6402c,
            0x2aa4ca55f6ef15e0b3627bb1610ffcade4ef8020e383c6c6d784e65df01847d4,
            0x14972bd95e5e0d5c9b7b4c7f7c5db32a881e6eec4b2e85d918e1e5483717f3b7,
            0x16bbe82c1e81ab0e5296184ee54a3a3fdfaf752f8c5b31ec8bbd9d0d10042dfa,
            0x08edb4d2f7a24699aacd18625346b24b05d9c9ceed16f7e99fa8ce412d07faf4,
            0x1c949a219bd55a6868156234510de696e2498d9dd9f43104c0000d0aeda7f012,
            0x11bb219757e87ebfc7461152a7f703e34606f17985d289cefded520893b6d7ae,
            0x2b122ed944ad488254ad38f4a3adb7df19aae81b8aea6c7d97399ce70e620c6d,
            0x1e959f4a86891d04d022059888db1b0b604a95113cb2b1d3446627f70712d930,
            0x2da9b44ce2f97f799a7898c083dfc6a0575b83ed0a46026e5d9891c6fc9d9f54,
            0x10f8c5ff08ecf34b3d0b9a09628cfd3a671a183df8df2b52d60b1a51b5feb30a,
            0x06f17102b4fd13b84c83d02964b4ce0ae4a50cb4ee48d09a318b7d6c33a4e016,
            0x15a264ad09bb4bed4a92d9888dc92c9b5db03095534f194f5e11ef0a12ad65ba,
            0x06e397e2eae16674f3e90f8294feb358afda5c2445e0690b495132602da60344,
            0x094ef8861f49ed0411315517c8af783c2f58502bec8a3e9cea8fefeb4cfc32ee,
            0x1a7d5fc505a324979a2f5dca70fc108afd235cf29fea1d811be7fc3e3c646b4e,
            0x25d7d016d898d28d932fd46b9e259e710991a1d3bb3a40a13b73fbc55e584dfd,
            0x0ff6a78caaab35f8d97f18e54699e96fcbb4908393d8e87af32b2a37b4ed3deb,
            0x0b6abc9e536dcfd0d5bd1817daf952574568d4b3b778dcf48c74b78a497a52eb,
            0x2dc9abaec1305edc14cf1355483516f3d286f65466ce8807d60439ad11787c62,
            0x2ae306d7a18b996fa7c474c2323350cd2e2741933ce55431825b5249637a5f56,
            0x2ec3ed6e2019aba2c09858cc4077932d24838e16beab82adb44ade7e4f11781b,
            0x07878c2d48e9b7b79a6c441583cba2af446fa2234a43160883070d30ea3c9288,
            0x0ddd82efb7355a32b2b07eebca4c932c7e3f08b49f4334e1ddf7d23420ede339,
            0x104ffa66f1e1524ff7fbe5262c9b4b2bf0e0fe75f39ea92b667f920bc8fc0052,
            0x025768694653be6d2e09e7df9b530e6cd43a97e70dd325461bea163714ddc889,
            0x2dbe3b46559fa9b4327f681537463f24d3ca357eb528b257cca88afb3d0f3176,
            0x1955520326f4bab1650508ad43bed3672dcccb8a8b61678e45872d764b9c9be0,
            0x243cddef20861798bd159324bfa63ac37bf752b9d9911fa871e3b72063432dcc,
            0x1d2592a7c046bc08293c14911b7bf11ff81324dd680c1fc6fbd05a8ebd17a523,
            0x15ab0e3b51d8a1f5cacc4e3c92e616fe80acf2cbb8af6068dba4d769c7cb7100,
            0x1976317e0c2b19e1b6c1ff93456fb91afa72ec9cc22c022f57b4fe7849a60645,
            0x0171e54c15c81f7ea87e716b2043acdcf2c1d896e3bcf88cbf58600d16b3983f,
            0x02d04e3d82c91ad6a8e7e6a15eaf251f6b9c0d8187d25217504b07f46808b2dc,
            0x1a411447d320e584b76c5c67070919a46daa09426ba62cf2214d24669e7d6545,
            0x29c4e75c431eae5e789df0653aa2e26cc9984b437970d5640e8bc0df46569ec0,
            0x0a3a31c9e1f9afb315b5cd4d80bb66b608b009b6ab749c7cb66902dd2b97e5d3,
            0x1302c16b26e4277e98198305edca293b3e5b55d6fa6bb6d0515ef1787f7c9b8d,
            0x223546bab07a62b3afb74156801a46813505d887da1453d29150cd7e4cb9ce10,
            0x28ccdcb6684ed21087c5098a3d60db50fc2ab1d95b35895eafb9cdbdb1cd78af,
            0x09a62b2f3f48175050be50ea817cb6e28137e55832c12b4d21006ee69117b1c2,
            0x13b1c6b229f53b02135ecda54e169d94c9fcca3ba9b351161f2ef8d1d57ec6f1,
            0x1c4c7da521c56b56669429239feb410e3e8dde9d4fcece112caafc7c174622dd,
            0x2267cfa1db428d2fd57554d1fe7cde044ef4916b3155de5f81f885d1648f2aa8
        ];
    }

    /// @dev Mirrors the input construction in circuits/vectors/src/main.nr exactly.
    function _input(uint256 s) internal pure returns (uint256[6] memory inp) {
        uint256 base = addmod(mulmod(s, 0x9e3779b97f4a7c15, P), 1, P);
        inp[0] = base;
        inp[1] = addmod(mulmod(base, 3, P), 7, P);
        inp[2] = addmod(mulmod(base, 5, P), 11, P);
        inp[3] = addmod(mulmod(base, 7, P), 13, P);
        inp[4] = addmod(mulmod(base, 11, P), 17, P);
        inp[5] = addmod(mulmod(base, 13, P), 19, P);
    }

    function test_Sweep_MatchesNoir() public pure {
        uint256[48] memory expected = _expected();
        for (uint256 s = 0; s < SEEDS; ++s) {
            uint256[6] memory full = _input(s);
            for (uint256 l = 1; l <= MAXLEN; ++l) {
                uint256[] memory inp = new uint256[](l);
                for (uint256 i = 0; i < l; ++i) {
                    inp[i] = full[i];
                }
                assertEq(
                    Poseidon2.hash(inp),
                    expected[s * MAXLEN + (l - 1)],
                    string.concat("mismatch at seed ", vm.toString(s), " len ", vm.toString(l))
                );
            }
        }
    }

    /// @dev Guards the property the tree depends on: the hash is a function of its input, so
    ///      distinct inputs must not collide across message sizes.
    function test_Sweep_NoCollisions() public pure {
        uint256[48] memory e = _expected();
        for (uint256 i = 0; i < 48; ++i) {
            assertTrue(e[i] != 0, "zero output");
            assertTrue(e[i] < P, "not reduced mod P");
            for (uint256 j = i + 1; j < 48; ++j) {
                assertTrue(e[i] != e[j], "collision");
            }
        }
    }
}
