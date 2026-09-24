// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {CommitmentTree} from "../src/CommitmentTree.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {EventCalendar} from "../src/EventCalendar.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {MockAggregatorV3, MockERC20Stock} from "../src/mocks/Mocks.sol";
import {MockVerifier} from "../src/mocks/MockVerifier.sol";

/// @notice Settlement carries two properties the venue's safety rests on: a cross moves no
///         tokens, and prices were committed only after the book was sealed.
contract RwaDarkPoolSettlementTest is Test {
    EligibleRegistry registry;
    EventCalendar calendar;
    PriceCommitter pricer;
    RwaDarkPool pool;
    MockERC20Stock nvda;
    MockAggregatorV3 feed;
    MockVerifier batchV;

    uint16 nvdaId;
    uint16 quoteId;
    address alice = address(0xA11CE);
    address constant USDG = address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    uint32 constant STALENESS = 1 hours;

    function setUp() public {
        vm.warp(1_789_000_000);
        registry = new EligibleRegistry(address(this), USDG);
        calendar = new EventCalendar(address(this));
        pricer = new PriceCommitter(address(this), registry, calendar);

        nvda = new MockERC20Stock();
        feed = new MockAggregatorV3();
        feed.setUpdatedAt(block.timestamp);
        nvdaId = registry.registerAsset(
            address(nvda), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );

        // The pool refuses a quote asset the registry does not know. A second asset, not the
        // traded one: a crossing proof refuses a window that prices the asset it pays out in.
        MockERC20Stock quote = new MockERC20Stock();
        MockAggregatorV3 quoteFeed = new MockAggregatorV3();
        quoteFeed.setUpdatedAt(block.timestamp);
        quoteId = registry.registerAsset(
            address(quote), address(quoteFeed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );

        batchV = new MockVerifier();
        pool = new RwaDarkPool(address(this), registry, pricer, batchV, batchV, batchV, quoteId);

        nvda.mint(alice, 1_000e18);
        vm.prank(alice);
        nvda.approve(address(pool), type(uint256).max);
    }

    function _deposit(uint128 units, uint256 salt) internal {
        bytes32 c = bytes32(salt);
        bytes32[] memory pi = new bytes32[](1);
        pi[0] = c;
        vm.prank(alice);
        pool.shield(nvdaId, units, c, hex"00", pi, hex"");
    }

    function _ids() internal view returns (uint16[] memory ids) {
        ids = new uint16[](1);
        ids[0] = nvdaId;
    }

    function _settleParams(uint64 windowId, uint8 idx)
        internal
        view
        returns (RwaDarkPool.SettleParams memory p)
    {
        p.windowId = windowId;
        p.subBatchIndex = idx;
        p.proof = hex"00";
        p.oldRoot = pool.currentRoot();
        p.outputsSubtreeRoot = bytes32(uint256(0xBEEF));
        // The circuit proves a fixed 32-leaf subtree, so the depth is always 5. It used to be 2
        // here, which the pool accepted — splicing proven leaves at unproven positions.
        p.outputsSubtreeDepth = pool.OUTPUTS_SUBTREE_DEPTH();
        // And a fixed 16 nullifier slots, one per order, unused ones zero. A shorter array would
        // verify a different statement than the one the circuit proves.
        p.nullifiers = new bytes32[](pool.BATCH_ORDERS());
        p.nullifiers[0] = bytes32(uint256(0x900 + idx));
        // 32 outputs, as the circuit always proves. Their contents are the settler's to publish;
        // the contract only fixes the count, because a client checks them against the proven
        // subtree root itself.
        p.outputCommitments = new bytes32[](1 << pool.OUTPUTS_SUBTREE_DEPTH());
        p.outputCommitments[0] = bytes32(uint256(0x01));
        p.receiptsRoot = bytes32(uint256(0xAAA));
        p.tapeLeaf = bytes32(uint256(0x7A9E));
        p.filledOrders = 1;
    }

    // =====================================================================================
    // property 1 — a cross moves no tokens
    // =====================================================================================

    /// @dev In a uniform-price internal cross every unit a buyer receives comes from a seller in
    ///      the same window, so settlement is pure bookkeeping. This is what reduces solvency to
    ///      an invariant that changes only on deposit and withdrawal.
    function test_SettlementMovesNoTokens() public {
        _deposit(100e18, 1);
        uint256 heldBefore = nvda.balanceOf(address(pool));
        uint256 owedBefore = pool.totalUnits(nvdaId);
        uint256 aliceBefore = nvda.balanceOf(alice);

        pool.sealWindow(1, bytes32(uint256(0xC1)), 4, 1);
        pricer.commitWindow(1, _ids());
        pool.settleBatch(_settleParams(1, 0));

        assertEq(nvda.balanceOf(address(pool)), heldBefore, "pool balance unchanged by a cross");
        assertEq(pool.totalUnits(nvdaId), owedBefore, "accounting unchanged by a cross");
        assertEq(nvda.balanceOf(alice), aliceBefore, "no user balance touched");
    }

    // =====================================================================================
    // property 4 — prices are committed after the book is sealed
    // =====================================================================================

    /// @dev The free-option defence. If the reference could be observed before the order set was
    ///      frozen, the operator could see the price and then choose which orders to include.
    function test_RejectsWindowPricedBeforeItWasSealed() public {
        _deposit(100e18, 1);

        // Price first, seal second — the forbidden order.
        pricer.commitWindow(7, _ids());
        vm.warp(block.timestamp + 1);
        pool.sealWindow(7, bytes32(uint256(0xC7)), 4, 1);

        RwaDarkPool.SettleParams memory p = _settleParams(7, 0);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WindowNotSealed.selector, uint64(7)));
        pool.settleBatch(p);
    }

    function test_RejectsUnpricedWindow() public {
        _deposit(100e18, 1);
        pool.sealWindow(2, bytes32(uint256(0xC2)), 4, 1);
        RwaDarkPool.SettleParams memory p = _settleParams(2, 0);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WindowNotPriced.selector, uint64(2)));
        pool.settleBatch(p);
    }

    function test_RejectsUnsealedWindow() public {
        _deposit(100e18, 1);
        RwaDarkPool.SettleParams memory p = _settleParams(3, 0);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WindowNotSealed.selector, uint64(3)));
        pool.settleBatch(p);
    }

    function test_WindowCannotBeResealed() public {
        pool.sealWindow(4, bytes32(uint256(0xC4)), 4, 1);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WindowAlreadySealed.selector, uint64(4)));
        pool.sealWindow(4, bytes32(uint256(0xC5)), 4, 1);
    }

    // =====================================================================================
    // sub-batch ordering and nullifiers
    // =====================================================================================

    /// @dev Sub-batches must land in order: each proves against the previous tree state, so an
    ///      out-of-order settlement would splice a subtree at the wrong index.
    function test_SubBatchesMustArriveInOrder() public {
        _deposit(100e18, 1);
        pool.sealWindow(5, bytes32(uint256(0xC6)), 8, 2);
        pricer.commitWindow(5, _ids());

        RwaDarkPool.SettleParams memory p = _settleParams(5, 1);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WrongSubBatch.selector, uint8(0), uint8(1)));
        pool.settleBatch(p);
    }

    function test_SettlementMarksNullifiers() public {
        _deposit(100e18, 1);
        pool.sealWindow(6, bytes32(uint256(0xC8)), 4, 1);
        pricer.commitWindow(6, _ids());
        pool.settleBatch(_settleParams(6, 0));
        assertTrue(pool.nullifierSpent(bytes32(uint256(0x900))), "consumed note marked spent");
        assertFalse(pool.nullifierSpent(bytes32(0)), "padding slot must not be marked");
    }

    // =====================================================================================
    // deposit queueing
    // =====================================================================================

    /// @dev A batch splices a span-aligned subtree, so a single insert landing mid-settlement
    ///      would misalign it. Deposits queue and drain when the window finalizes.
    function test_DepositsQueueDuringSettlementAndDrainAfter() public {
        _deposit(100e18, 1);
        uint32 indexBefore = pool.nextLeafIndex();

        pool.sealWindow(8, bytes32(uint256(0xC9)), 4, 1);
        _deposit(10e18, 2);
        assertEq(pool.pendingDepositCount(), 1, "queued rather than inserted");
        assertEq(pool.nextLeafIndex(), indexBefore, "tree untouched mid-settlement");
        // The tokens are held and the accounting credited even while the leaf waits.
        assertEq(pool.totalUnits(nvdaId), 110e18, "units credited immediately");

        pricer.commitWindow(8, _ids());
        pool.settleBatch(_settleParams(8, 0));

        assertEq(pool.pendingDepositCount(), 0, "queue drained on finalize");
        assertGt(pool.nextLeafIndex(), indexBefore, "leaf eventually lands");
    }

    /// @dev Deposits taken before a window was sealed leave the tree at an arbitrary index, so
    ///      settlement aligns before splicing rather than reverting. Alignment jumps the index
    ///      instead of inserting padding — proven equivalent to zero-filling in
    ///      `test_SkippingEqualsInsertingZeroLeaves`, and it avoids tens of millions of gas.
    function test_SettlementAlignsAnArbitraryIndex() public {
        // A subtree may only occupy a span-aligned slot, and deposits before the seal leave the
        // index wherever they leave it. The span is 2^5 = 32, because the circuit always proves
        // 32 output leaves.
        uint256 span = 1 << pool.OUTPUTS_SUBTREE_DEPTH();

        _deposit(100e18, 1); // nextLeafIndex = 1, not a multiple of 32
        assertEq(pool.nextLeafIndex(), 1, "deposit left the tree unaligned");

        pool.sealWindow(9, bytes32(uint256(0xCA)), 4, 1);
        pricer.commitWindow(9, _ids());
        pool.settleBatch(_settleParams(9, 0));

        // Skipped forward to the next aligned slot, then consumed the whole span.
        assertEq(pool.nextLeafIndex(), span * 2, "aligned to the span, then consumed it");
    }
    // =====================================================================================
    // voiding — the way out of a window that cannot be settled
    // =====================================================================================

    /// A window only closes by settling, and settling needs a proof. Without a void path, a proof
    /// that can never be produced wedges the venue: every later deposit queues instead of
    /// entering the tree, permanently. This was found by hitting it on the live testnet.
    function test_AnUnsettleableWindowWedgesDepositsUntilVoided() public {
        pool.sealWindow(20, bytes32(uint256(0xDEAD)), 4, 1);

        // Deposits during an open settlement queue rather than insert, so the tree does not move.
        uint32 before = pool.nextLeafIndex();
        _deposit(10e18, 0xC1);
        assertEq(pool.nextLeafIndex(), before, "deposit entered the tree during settlement");
        assertEq(pool.pendingDepositCount(), 1, "deposit was not queued");

        pool.voidWindow(20);

        assertEq(pool.nextLeafIndex(), before + 1, "voiding did not drain the queue");
        assertEq(pool.pendingDepositCount(), 0, "queue still holds deposits");
        assertEq(pool.openWindowId(), 0, "window is still open");
    }

    function test_VoidingMovesNoValue() public {
        pool.sealWindow(21, bytes32(uint256(0xDEAD)), 4, 1);
        _deposit(10e18, 0xC2);

        uint256 owedBefore = pool.totalUnits(nvdaId);
        uint256 heldBefore = nvda.balanceOf(address(pool));

        pool.voidWindow(21);

        // The whole safety argument for making this permissionless: voiding cannot take anything
        // from anyone. No tokens move, no nullifier is marked, so every note in the window is
        // still spendable by its owner.
        assertEq(pool.totalUnits(nvdaId), owedBefore, "voiding changed what the pool owes");
        assertEq(nvda.balanceOf(address(pool)), heldBefore, "voiding moved tokens");
        (bool solvent,,) = pool.isSolvent(nvdaId);
        assertTrue(solvent, "voiding broke solvency");
    }

    function test_AVoidedWindowCannotBeSettledLater() public {
        pool.sealWindow(22, bytes32(uint256(0xDEAD)), 4, 1);
        pricer.commitWindow(22, _ids());
        pool.voidWindow(22);

        // Built before arming: `_settleParams` reads `pool.currentRoot()`, and an external call
        // after `expectRevert` consumes the expectation instead of the call under test.
        RwaDarkPool.SettleParams memory p = _settleParams(22, 0);

        // Otherwise a late proof could splice a subtree into a tree that has already moved on.
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WindowFinalized.selector, uint64(22)));
        pool.settleBatch(p);
    }

    function test_AVoidedWindowCannotBeVoidedTwice() public {
        pool.sealWindow(23, bytes32(uint256(0xDEAD)), 4, 1);
        pool.voidWindow(23);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WindowFinalized.selector, uint64(23)));
        pool.voidWindow(23);
    }

    function test_AStrangerMustWaitForTheDeadline() public {
        pool.sealWindow(24, bytes32(uint256(0xDEAD)), 4, 1);
        address stranger = address(0x5721A6E1);

        vm.prank(stranger);
        vm.expectRevert();
        pool.voidWindow(24);

        // After the deadline, recovery does not depend on the operator being available.
        vm.warp(block.timestamp + pool.settlementDeadline());
        vm.prank(stranger);
        pool.voidWindow(24);
        assertEq(pool.openWindowId(), 0, "a stranger could not recover the venue");
    }

    function test_AGuardianNeedNotWait() public {
        // Waiting an hour to recover from a prover crash is an hour of rejected deposits.
        pool.sealWindow(25, bytes32(uint256(0xDEAD)), 4, 1);
        pool.voidWindow(25);
        assertEq(pool.openWindowId(), 0, "guardian could not void immediately");
    }

    function test_AnUnsealedWindowCannotBeVoided() public {
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.WindowNotSealed.selector, uint64(99)));
        pool.voidWindow(99);
    }

    /// Voiding is the plan's documented failure path: "past deadline_at -> VOID. Nullifiers are
    /// published only at settlement, so a proving failure can never strand funds." This asserts
    /// the second half of that sentence.
    function test_NotesInAVoidedWindowAreStillSpendable() public {
        bytes32 nullifier = bytes32(uint256(0x900));
        pool.sealWindow(26, bytes32(uint256(0xDEAD)), 4, 1);
        pool.voidWindow(26);
        assertFalse(pool.nullifierSpent(nullifier), "voiding spent a note");
    }

    /// Without the output commitments on chain, a note created by a settlement could never be
    /// spent: its owner could not build a Merkle path to a leaf nobody published. `LeafInserted`
    /// does not cover them, because a splice moves 32 leaves in one operation.
    function test_SettlementPublishesItsOutputCommitments() public {
        pool.sealWindow(30, bytes32(uint256(0xC0)), 4, 1);
        pricer.commitWindow(30, _ids());
        RwaDarkPool.SettleParams memory p = _settleParams(30, 0);

        vm.recordLogs();
        pool.settleBatch(p);

        // The event carries the whole subtree, plus the index it landed at and the proven root a
        // client checks the leaves against.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != keccak256("OutputsPublished(uint64,uint8,uint32,bytes32,bytes32[])")) continue;
            (,, bytes32 subtreeRoot, bytes32[] memory commitments) =
                abi.decode(logs[i].data, (uint8, uint32, bytes32, bytes32[]));
            assertEq(commitments.length, 1 << pool.OUTPUTS_SUBTREE_DEPTH(), "wrong output count");
            assertEq(subtreeRoot, p.outputsSubtreeRoot, "event cites a different subtree");
            found = true;
        }
        assertTrue(found, "settlement published no outputs");
    }

    function test_RejectsAWrongOutputCount() public {
        pool.sealWindow(31, bytes32(uint256(0xC0)), 4, 1);
        pricer.commitWindow(31, _ids());
        RwaDarkPool.SettleParams memory p = _settleParams(31, 0);
        p.outputCommitments = new bytes32[](4);
        vm.expectRevert(
            abi.encodeWithSelector(RwaDarkPool.WrongOutputCount.selector, uint256(32), uint256(4))
        );
        pool.settleBatch(p);
    }

}
