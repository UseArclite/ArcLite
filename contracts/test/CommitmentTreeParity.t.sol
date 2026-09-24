// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TreeHarness} from "./harness/TreeHarness.sol";

/// @notice The commitment tree is built twice: once here by `CommitmentTree.sol`, and once
///         implicitly by every circuit that reconstructs a root from a leaf and a path. If the
///         two disagree by a single hash the contract accepts roots no prover can reach — or
///         accepts a root for a tree it did not build.
///
///         Expected values come from `circuits/tree`, executed by nargo against the same
///         barretenberg Poseidon2 blackbox the circuits use. Independent ground truth, not a
///         restatement of the Solidity.
///
///         Regenerate: cd circuits && nargo execute --package tree out
contract CommitmentTreeParityTest is Test {
    TreeHarness tree;

    bytes32 constant NOIR_EMPTY_ROOT = 0x0e1a6b7d63a6e5a9e54e8f391dd4e9d49cdfedcbc87f02cd34d4641d2eb30491;
    bytes32 constant NOIR_ONE_LEAF_ROOT = 0x0f1163e4a6c699933f342fee0d8c188626c7999bb17ad8b72f27836540cd840b;
    bytes32 constant NOIR_FOUR_LEAF_ROOT = 0x2f4adc76aa848323a416713836219d439717ee67fb141abe08daf724827909c5;
    bytes32 constant NOIR_HASH2_1_2 = 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383;

    function setUp() public {
        tree = new TreeHarness();
    }

    /// @dev The zero-subtree ladder is derived in the constructor. If it drifted, every sparse
    ///      branch of every membership proof would be wrong.
    function test_EmptyRootMatchesNoir() public view {
        assertEq(tree.currentRoot(), NOIR_EMPTY_ROOT, "empty depth-24 root");
    }

    function test_Hash2MatchesNoir() public view {
        assertEq(tree.hash2(bytes32(uint256(1)), bytes32(uint256(2))), NOIR_HASH2_1_2, "hash2(1,2)");
    }

    function test_OneLeafRootMatchesNoir() public {
        tree.insert(bytes32(uint256(1)));
        assertEq(tree.currentRoot(), NOIR_ONE_LEAF_ROOT, "root after one leaf");
    }

    function test_FourLeafRootMatchesNoir() public {
        tree.insert(bytes32(uint256(11)));
        tree.insert(bytes32(uint256(22)));
        tree.insert(bytes32(uint256(33)));
        tree.insert(bytes32(uint256(44)));
        assertEq(tree.currentRoot(), NOIR_FOUR_LEAF_ROOT, "root after four leaves");
    }

    /// @dev Splicing a subtree must land on the same root as inserting its leaves — otherwise a
    ///      batch settlement and a run of deposits would build different trees from the same
    ///      commitments.
    function test_SubtreeRouteMatchesNoirToo() public {
        bytes32 sub = tree.hash2(
            tree.hash2(bytes32(uint256(11)), bytes32(uint256(22))),
            tree.hash2(bytes32(uint256(33)), bytes32(uint256(44)))
        );
        tree.insertSubtree(sub, 2);
        assertEq(tree.currentRoot(), NOIR_FOUR_LEAF_ROOT, "subtree route must agree with Noir");
    }
}
