// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommitmentTree} from "../../src/CommitmentTree.sol";

/// @dev Exposes the abstract tree's internals for testing. Not deployed.
contract TreeHarness is CommitmentTree {
    function insert(bytes32 leaf) external returns (uint32) {
        return _insert(leaf);
    }

    function insertSubtree(bytes32 root, uint8 depth) external returns (uint32) {
        return _insertSubtree(root, depth);
    }

    function hash2(bytes32 a, bytes32 b) external pure returns (bytes32) {
        return _hash(a, b);
    }

    function alignForSubtree(uint8 depth) external returns (uint32) {
        return _alignForSubtree(depth);
    }
}
