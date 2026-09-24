// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Poseidon2} from "./libraries/Poseidon2.sol";

/// @title Append-only incremental Merkle tree over Poseidon2
/// @notice Holds the note commitments the darkpool's circuits prove membership against. The tree
///         is computed in two places — here, and in-circuit — so the hash must agree exactly;
///         that parity is pinned by `test/Poseidon2Parity.t.sol` and is a fund-loss-class
///         property, not a nicety.
///
///         Incremental construction keeps an insert at O(depth) rather than O(2^depth): only the
///         right-most filled node per level is retained, since every node to the right of the
///         frontier is still a known zero.
///
///         Roots are kept in a ring buffer because a proof is built against whatever root was
///         current when the prover started. Requiring the *latest* root would make every proof
///         race every deposit.
abstract contract CommitmentTree {
    /// @dev 2^24 ≈ 16.7M notes. Depth drives insert cost directly (one Poseidon2 per level), so
    ///      it is a deliberate ceiling rather than a generous one.
    uint256 public constant DEPTH = 24;
    uint256 public constant ROOT_HISTORY = 128;

    error TreeFull();
    error LeafOutOfRange();
    error SubtreeMisaligned(uint256 nextIndex, uint256 span);

    event LeafInserted(uint256 indexed index, bytes32 indexed commitment, bytes32 root);
    event SubtreeInserted(uint256 indexed startIndex, uint8 depth, bytes32 subtreeRoot, bytes32 root);
    event LeavesSkipped(uint256 indexed fromIndex, uint32 count);

    /// @dev Right-most filled node at each level; everything to its right is a zero subtree.
    bytes32[DEPTH] internal _filledSubtrees;
    /// @dev Precomputed roots of empty subtrees, `_zeros[i]` being an empty subtree of height i.
    bytes32[DEPTH + 1] internal _zeros;

    bytes32[ROOT_HISTORY] internal _rootHistory;
    uint32 public rootIndex;
    uint32 public nextLeafIndex;

    constructor() {
        // Zero subtrees are derived, never hardcoded: a transcription error here would be
        // invisible until a membership proof failed against a sparse branch.
        bytes32 current = bytes32(0);
        for (uint256 i = 0; i < DEPTH; ++i) {
            _zeros[i] = current;
            _filledSubtrees[i] = current;
            current = _hash(current, current);
        }
        _zeros[DEPTH] = current;
        _rootHistory[0] = current;
    }

    function _hash(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return bytes32(Poseidon2.hash2(uint256(left), uint256(right)));
    }

    function currentRoot() public view returns (bytes32) {
        return _rootHistory[rootIndex];
    }

    /// @notice Whether `root` is one of the last ROOT_HISTORY roots.
    /// @dev    A proof references the root that was current when it was built, so accepting only
    ///         the newest would make concurrent deposits invalidate in-flight proofs.
    function isKnownRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        uint32 i = rootIndex;
        for (uint256 n = 0; n < ROOT_HISTORY; ++n) {
            if (_rootHistory[i] == root) return true;
            i = i == 0 ? uint32(ROOT_HISTORY - 1) : i - 1;
        }
        return false;
    }

    function _insert(bytes32 leaf) internal returns (uint32 index) {
        index = nextLeafIndex;
        if (index >= uint32(1 << DEPTH)) revert TreeFull();

        uint256 idx = index;
        bytes32 node = leaf;
        for (uint256 level = 0; level < DEPTH; ++level) {
            if (idx & 1 == 0) {
                // Left child: the sibling is still empty, so remember this node as the frontier.
                _filledSubtrees[level] = node;
                node = _hash(node, _zeros[level]);
            } else {
                node = _hash(_filledSubtrees[level], node);
            }
            idx >>= 1;
        }

        nextLeafIndex = index + 1;
        _pushRoot(node);
        emit LeafInserted(index, leaf, node);
    }

    /// @notice Splice a pre-computed subtree of height `depth` into the next aligned slot.
    /// @dev    Lets a batch publish 2^depth outputs for the cost of DEPTH-depth hashes instead of
    ///         2^depth inserts. Alignment is required: a subtree can only occupy a slot whose
    ///         index is a multiple of its span, so callers must drain pending single inserts
    ///         before splicing.
    function _insertSubtree(bytes32 subtreeRoot, uint8 depth) internal returns (uint32 startIndex) {
        if (depth == 0 || depth >= DEPTH) revert LeafOutOfRange();
        uint256 span = 1 << depth;
        startIndex = nextLeafIndex;
        if (startIndex % span != 0) revert SubtreeMisaligned(startIndex, span);
        if (uint256(startIndex) + span > (1 << DEPTH)) revert TreeFull();

        uint256 idx = uint256(startIndex) >> depth;
        bytes32 node = subtreeRoot;
        for (uint256 level = depth; level < DEPTH; ++level) {
            if (idx & 1 == 0) {
                _filledSubtrees[level] = node;
                node = _hash(node, _zeros[level]);
            } else {
                node = _hash(_filledSubtrees[level], node);
            }
            idx >>= 1;
        }

        nextLeafIndex = startIndex + uint32(span);
        _pushRoot(node);
        emit SubtreeInserted(startIndex, depth, subtreeRoot, node);
    }

    /// @notice Advance to the next slot where a depth-`depth` subtree may be spliced.
    /// @dev    Skipped positions are simply never filled, and that is safe: the frontier already
    ///         encodes every unfilled slot as a zero subtree, so the root computed after a jump
    ///         is exactly the root of the same leaves with zeros in the gaps. Nothing is
    ///         inserted, so alignment costs one storage write rather than up to 2^depth-1 hashes
    ///         — padding with real inserts would cost tens of millions of gas at depth 5.
    ///
    ///         The wasted leaf slots are irrelevant at depth 24 (16.7M), and the alternative —
    ///         letting a batch splice land wherever deposits happened to leave the index — would
    ///         corrupt the tree.
    function _alignForSubtree(uint8 depth) internal returns (uint32 skipped) {
        if (depth == 0 || depth >= DEPTH) revert LeafOutOfRange();
        uint256 span = 1 << depth;
        uint256 rem = uint256(nextLeafIndex) % span;
        if (rem == 0) return 0;
        skipped = uint32(span - rem);
        uint256 target = uint256(nextLeafIndex) + skipped;
        if (target > (1 << DEPTH)) revert TreeFull();
        nextLeafIndex = uint32(target);
        emit LeavesSkipped(nextLeafIndex - skipped, skipped);
    }

    function _pushRoot(bytes32 root) private {
        rootIndex = uint32((uint256(rootIndex) + 1) % ROOT_HISTORY);
        _rootHistory[rootIndex] = root;
    }

    function zeros(uint256 level) external view returns (bytes32) {
        if (level > DEPTH) revert LeafOutOfRange();
        return _zeros[level];
    }
}
