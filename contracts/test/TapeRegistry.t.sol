// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Poseidon2} from "../src/libraries/Poseidon2.sol";
import {TapeRegistry, IPoolWindows} from "../src/TapeRegistry.sol";

/// @dev A stand-in for the pool's window storage, so the tape's rules can be tested against
///      every window shape — voided, suppressed, unsettled — without driving a full settlement
///      for each one.
contract FakePool is IPoolWindows {
    mapping(uint64 => Window) private _w;

    function set(uint64 id, Window memory w) external {
        _w[id] = w;
    }

    function windows(uint64 id) external view override returns (Window memory) {
        return _w[id];
    }
}

/// @notice The tape's credibility rests on commitment-then-reveal, so these tests are mostly
///         about what the registry *refuses*: an edited volume, an early release, a window with
///         too few orders to aggregate honestly.
contract TapeRegistryTest is Test {
    uint256 internal constant DOMAIN_TAPE = 0x74617065; // "tape"
    uint256 internal constant MAX_ASSETS = 32;
    uint64 internal constant DELAY = 15 minutes;
    uint16 internal constant K = 3;

    FakePool internal pool;
    TapeRegistry internal tape;

    uint16[] internal assetIds;
    uint128[] internal volumes;

    function setUp() public {
        vm.warp(1_789_000_000);
        pool = new FakePool();
        tape = new TapeRegistry(IPoolWindows(address(pool)), DELAY, K);

        // Three live rows, matching a window priced over three assets. The third traded nothing,
        // which is committed to but does not earn a tape entry.
        assetIds = new uint16[](3);
        volumes = new uint128[](3);
        assetIds[0] = 1;
        volumes[0] = 20;
        assetIds[1] = 2;
        volumes[1] = 55;
        assetIds[2] = 3;
        volumes[2] = 0;
    }

    /// Reproduces `batch_cross`'s tape leaf. Kept here rather than reusing the registry's private
    /// helper so the test is an independent statement of the format, not a restatement of it.
    function _leaf(uint64 windowId, uint8 subBatchIndex) internal view returns (bytes32) {
        uint256 h = Poseidon2.hash2(
            Poseidon2.hash2(DOMAIN_TAPE, uint256(windowId)),
            Poseidon2.hash2(uint256(subBatchIndex), 1)
        );
        for (uint256 i = 0; i < assetIds.length; ++i) {
            h = Poseidon2.hash2(h, Poseidon2.hash2(uint256(assetIds[i]), uint256(volumes[i])));
        }
        return bytes32(h);
    }

    function _commitment(uint64 windowId, uint8 subBatchCount) internal view returns (bytes32 c) {
        for (uint8 i = 0; i < subBatchCount; ++i) {
            c = keccak256(abi.encode(c, _leaf(windowId, i)));
        }
    }

    function _settle(uint64 id, uint16 orderCount, uint8 subBatches) internal {
        pool.set(
            id,
            IPoolWindows.Window({
                ordersRoot: bytes32(uint256(0xB0)),
                tapeCommitment: _commitment(id, subBatches),
                sealedAt: uint64(block.timestamp),
                settledAt: uint64(block.timestamp),
                orderCount: orderCount,
                subBatchCount: subBatches,
                subBatchesSettled: subBatches,
                finalized: true,
                voided: false
            })
        );
    }

    // ------------------------------------------------------------------------------------
    // the happy path
    // ------------------------------------------------------------------------------------

    function test_PublishesTheProvenVolumesAfterTheDelay() public {
        _settle(1, 8, 1);
        vm.warp(block.timestamp + DELAY);

        tape.publishTape(1, 1, assetIds, volumes);

        TapeRegistry.Entry[] memory e = tape.entries(1);
        // Only the non-zero rows are stored: the zeros were committed to but say nothing.
        assertEq(e.length, 2, "expected two assets on the tape");
        assertEq(e[0].assetId, 1);
        assertEq(e[0].volume, 20);
        assertEq(e[1].assetId, 2);
        assertEq(e[1].volume, 55);
        assertTrue(tape.published(1));
    }

    function test_AnyoneMayPublish() public {
        // A tape only the operator can publish is a tape that goes unpublished the moment it is
        // inconvenient. The commitment is the authority, not the caller.
        _settle(2, 8, 1);
        vm.warp(block.timestamp + DELAY);
        vm.prank(address(0x5721A6E1));
        tape.publishTape(2, 1, assetIds, volumes);
        assertTrue(tape.published(2));
    }

    function test_ChainsEverySubBatch() public {
        // Four sub-batches, one commitment. A tape that only matched the last one would let the
        // operator omit the others.
        _settle(3, 40, 4);
        vm.warp(block.timestamp + DELAY);
        tape.publishTape(3, 4, assetIds, volumes);
        assertTrue(tape.published(3));
    }

    // ------------------------------------------------------------------------------------
    // what it refuses
    // ------------------------------------------------------------------------------------

    function test_RejectsAnEditedVolume() public {
        // The whole point. The numbers were fixed at proving time.
        _settle(4, 8, 1);
        vm.warp(block.timestamp + DELAY);
        volumes[0] = 21;
        vm.expectRevert();
        tape.publishTape(4, 1, assetIds, volumes);
    }

    function test_RejectsAReassignedAsset() public {
        // Same volumes, attributed to a different asset — a plausible edit that conservation
        // checks would not notice.
        _settle(5, 8, 1);
        vm.warp(block.timestamp + DELAY);
        assetIds[0] = 7;
        vm.expectRevert();
        tape.publishTape(5, 1, assetIds, volumes);
    }

    function test_RejectsAnAddedRow() public {
        // Inventing volume in a row the window never traded.
        _settle(6, 8, 1);
        vm.warp(block.timestamp + DELAY);
        assetIds[2] = 9;
        volumes[2] = 1000;
        vm.expectRevert();
        tape.publishTape(6, 1, assetIds, volumes);
    }

    function test_RejectsEarlyPublication() public {
        // A tape published instantly is a real-time feed, which defeats a dark venue.
        _settle(7, 8, 1);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        tape.publishTape(7, 1, assetIds, volumes);
    }

    function test_RejectsAnUnsettledWindow() public {
        pool.set(
            8,
            IPoolWindows.Window({
                ordersRoot: bytes32(0), tapeCommitment: bytes32(0),
                sealedAt: uint64(block.timestamp), settledAt: 0, orderCount: 8,
                subBatchCount: 1, subBatchesSettled: 0, finalized: false, voided: false
            })
        );
        vm.expectRevert(abi.encodeWithSelector(TapeRegistry.WindowNotSettled.selector, uint64(8)));
        tape.publishTape(8, 1, assetIds, volumes);
    }

    function test_RejectsAVoidedWindow() public {
        // A voided window crossed nothing. An all-zero tape would be accurate and misleading —
        // it reads as "the venue was open and nothing traded".
        _settle(9, 8, 1);
        IPoolWindows.Window memory w = pool.windows(9);
        w.voided = true;
        pool.set(9, w);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(TapeRegistry.WindowVoided.selector, uint64(9)));
        tape.publishTape(9, 1, assetIds, volumes);
    }

    function test_SuppressesAWindowWithTooFewOrders() public {
        // An aggregate of one is not an aggregate: it publishes that trader's size exactly.
        _settle(10, K - 1, 1);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(TapeRegistry.Suppressed.selector, uint64(10), K - 1, K)
        );
        tape.publishTape(10, 1, assetIds, volumes);
    }

    function test_CannotPublishTwice() public {
        _settle(11, 8, 1);
        vm.warp(block.timestamp + DELAY);
        tape.publishTape(11, 1, assetIds, volumes);
        vm.expectRevert(abi.encodeWithSelector(TapeRegistry.AlreadyPublished.selector, uint64(11)));
        tape.publishTape(11, 1, assetIds, volumes);
    }

    function test_RejectsATruncatedTable() public {
        // The leaf chains all 32 rows, so a truncated table is a different commitment.
        _settle(12, 8, 1);
        vm.warp(block.timestamp + DELAY);
        // Two rows where the commitment chains three: a different chain, so it cannot match.
        uint16[] memory shortIds = new uint16[](2);
        uint128[] memory shortVols = new uint128[](2);
        shortIds[0] = 1; shortVols[0] = 20;
        shortIds[1] = 2; shortVols[1] = 55;
        vm.expectRevert();
        tape.publishTape(12, 1, shortIds, shortVols);
    }

    function test_RejectsAWrongSubBatchCount() public {
        _settle(13, 8, 2);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        tape.publishTape(13, 1, assetIds, volumes); // claims one, the commitment chains two
    }

    // ------------------------------------------------------------------------------------
    // status
    // ------------------------------------------------------------------------------------

    function test_StatusExplainsWhyATapeIsNotAvailable() public {
        _settle(14, 8, 1);
        (bool isPublished, bool isPublishable, bool isSuppressed, uint64 at) = tape.status(14);
        assertFalse(isPublished);
        assertFalse(isPublishable, "not yet: still inside the delay");
        assertFalse(isSuppressed);
        assertEq(at, uint64(block.timestamp) + DELAY);

        vm.warp(at);
        (, isPublishable,,) = tape.status(14);
        assertTrue(isPublishable);

        tape.publishTape(14, 1, assetIds, volumes);
        (isPublished, isPublishable,,) = tape.status(14);
        assertTrue(isPublished);
        assertFalse(isPublishable);
    }

    function test_StatusReportsSuppression() public {
        _settle(15, 1, 1);
        (,, bool isSuppressed,) = tape.status(15);
        assertTrue(isSuppressed, "a one-order window must read as suppressed, not merely pending");
    }
}
