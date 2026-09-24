// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommitmentTree} from "../src/CommitmentTree.sol";
import {TreeHarness} from "./harness/TreeHarness.sol";

/// @notice The tree is computed here and in-circuit, so it must be right in both. These tests
///         pin the on-chain half; `test_MatchesNoirTree` in Poseidon2Sweep pins the agreement.
contract CommitmentTreeTest is Test {
    TreeHarness tree;

    function setUp() public {
        tree = new TreeHarness();
    }

    /// @dev An empty tree's root must be the depth-24 zero subtree, derived rather than assumed.
    function test_EmptyRootIsZeroSubtree() public view {
        assertEq(tree.currentRoot(), tree.zeros(tree.DEPTH()), "empty root");
        assertEq(tree.nextLeafIndex(), 0);
    }

    function test_InsertAdvancesIndexAndRoot() public {
        bytes32 before = tree.currentRoot();
        uint32 idx = tree.insert(bytes32(uint256(1)));
        assertEq(idx, 0, "first leaf index");
        assertEq(tree.nextLeafIndex(), 1);
        assertTrue(tree.currentRoot() != before, "root must move");
    }

    /// @dev The whole point of the ring buffer: a proof built against an older root stays valid
    ///      while other deposits land, otherwise every proof races every deposit.
    function test_OldRootsStayKnown() public {
        bytes32[] memory roots = new bytes32[](8);
        for (uint256 i = 0; i < 8; ++i) {
            tree.insert(bytes32(uint256(i + 1)));
            roots[i] = tree.currentRoot();
        }
        for (uint256 i = 0; i < 8; ++i) {
            assertTrue(tree.isKnownRoot(roots[i]), "recent root must be known");
        }
    }

    function test_UnknownRootRejected() public view {
        assertFalse(tree.isKnownRoot(bytes32(uint256(0xdead))), "arbitrary root");
        assertFalse(tree.isKnownRoot(bytes32(0)), "zero is never a valid root");
    }

    /// @dev A root falls out of history once ROOT_HISTORY newer ones exist. Proofs older than
    ///      that must be rebuilt — a real constraint worth knowing rather than discovering.
    function test_RootExpiresFromHistory() public {
        tree.insert(bytes32(uint256(1)));
        bytes32 oldest = tree.currentRoot();
        assertTrue(tree.isKnownRoot(oldest));
        for (uint256 i = 0; i < tree.ROOT_HISTORY(); ++i) {
            tree.insert(bytes32(uint256(i + 2)));
        }
        assertFalse(tree.isKnownRoot(oldest), "root should have aged out");
    }

    /// @dev Two trees given the same leaves in the same order must agree — the property the
    ///      circuit relies on when it recomputes a root from a path.
    function test_Deterministic() public {
        TreeHarness other = new TreeHarness();
        for (uint256 i = 0; i < 6; ++i) {
            tree.insert(bytes32(uint256(i * 7 + 3)));
            other.insert(bytes32(uint256(i * 7 + 3)));
        }
        assertEq(tree.currentRoot(), other.currentRoot(), "same leaves, same root");
    }

    function test_OrderMatters() public {
        TreeHarness other = new TreeHarness();
        tree.insert(bytes32(uint256(1)));
        tree.insert(bytes32(uint256(2)));
        other.insert(bytes32(uint256(2)));
        other.insert(bytes32(uint256(1)));
        assertTrue(tree.currentRoot() != other.currentRoot(), "order must change the root");
    }

    /// @dev A subtree may only occupy a slot aligned to its span. Splicing at a misaligned index
    ///      would silently corrupt the tree, so it reverts.
    function test_SubtreeRequiresAlignment() public {
        tree.insert(bytes32(uint256(1))); // nextLeafIndex = 1
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentTree.SubtreeMisaligned.selector, uint256(1), uint256(32))
        );
        tree.insertSubtree(bytes32(uint256(99)), 5);
    }

    function test_SubtreeAtAlignedSlot() public {
        uint32 start = tree.insertSubtree(bytes32(uint256(99)), 5);
        assertEq(start, 0, "first subtree starts at 0");
        assertEq(tree.nextLeafIndex(), 32, "subtree consumes its whole span");
    }

    /// @dev Splicing a subtree must produce exactly the root that inserting its leaves would,
    ///      or a batch settlement and a sequence of deposits would disagree about the same tree.
    function test_SubtreeEqualsIndividualInserts() public {
        TreeHarness byLeaves = new TreeHarness();
        // Build a depth-2 (4-leaf) subtree by hand, then compare against four inserts.
        bytes32 l0 = bytes32(uint256(11));
        bytes32 l1 = bytes32(uint256(22));
        bytes32 l2 = bytes32(uint256(33));
        bytes32 l3 = bytes32(uint256(44));
        for (uint256 i = 0; i < 4; ++i) {
            byLeaves.insert([l0, l1, l2, l3][i]);
        }
        bytes32 subRoot = tree.hash2(tree.hash2(l0, l1), tree.hash2(l2, l3));
        tree.insertSubtree(subRoot, 2);
        assertEq(tree.currentRoot(), byLeaves.currentRoot(), "subtree must equal its leaves");
        assertEq(tree.nextLeafIndex(), byLeaves.nextLeafIndex(), "index must agree too");
    }

    function test_SubtreeDepthBounds() public {
        // Read DEPTH() first: vm.expectRevert arms the *next* call, and an external getter
        // placed after it would consume the expectation instead of insertSubtree.
        uint8 depth = uint8(tree.DEPTH());

        vm.expectRevert(CommitmentTree.LeafOutOfRange.selector);
        tree.insertSubtree(bytes32(uint256(1)), 0);

        vm.expectRevert(CommitmentTree.LeafOutOfRange.selector);
        tree.insertSubtree(bytes32(uint256(1)), depth);
    }

    /// @dev The soundness argument for skipping. Deposits leave the tree at an arbitrary index,
    ///      so a batch must align before splicing — and alignment jumps the index rather than
    ///      inserting padding, which at depth 5 would cost tens of millions of gas. This proves
    ///      the jump is equivalent: an unfilled slot and an explicitly-inserted zero leaf are the
    ///      same thing to the frontier. If they ever diverge, every root after a batch is wrong.
    function test_SkippingEqualsInsertingZeroLeaves() public {
        TreeHarness padded = new TreeHarness();

        bytes32 leaf = bytes32(uint256(7));
        bytes32 sub = tree.hash2(bytes32(uint256(1)), bytes32(uint256(2)));

        // Jump the index.
        tree.insert(leaf);
        uint32 skipped = tree.alignForSubtree(2);
        assertEq(skipped, 3, "index 1 needs 3 slots to reach 4");
        tree.insertSubtree(sub, 2);

        // Fill the same gap with explicit zero leaves.
        padded.insert(leaf);
        padded.insert(bytes32(0));
        padded.insert(bytes32(0));
        padded.insert(bytes32(0));
        padded.insertSubtree(sub, 2);

        assertEq(tree.currentRoot(), padded.currentRoot(), "skipping must equal zero-padding");
        assertEq(tree.nextLeafIndex(), padded.nextLeafIndex(), "and leave the same index");
    }

    function test_AlignIsANoOpWhenAlreadyAligned() public {
        assertEq(tree.alignForSubtree(2), 0, "index 0 is already aligned");
        tree.insert(bytes32(uint256(1)));
        tree.insert(bytes32(uint256(2)));
        tree.insert(bytes32(uint256(3)));
        tree.insert(bytes32(uint256(4)));
        assertEq(tree.alignForSubtree(2), 0, "index 4 is already aligned");
    }

    /// @dev Insert cost is one Poseidon2 per level and drives the settlement gas budget, so it
    ///      is measured rather than assumed. Cheap on an Orbit L2; the real bill is L1 calldata.
    function test_InsertGasIsBounded() public {
        tree.insert(bytes32(uint256(1)));
        uint256 before = gasleft();
        tree.insert(bytes32(uint256(2)));
        uint256 used = before - gasleft();
        emit log_named_uint("gas per insert", used);
        assertLt(used, 2_500_000, "insert should stay well under an Orbit block");
    }
}
