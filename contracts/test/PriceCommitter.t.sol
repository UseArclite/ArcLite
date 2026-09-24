// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {EventCalendar} from "../src/EventCalendar.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {MockAggregatorV3, MockNavOracle, MockStockToken} from "../src/mocks/Mocks.sol";

/// @notice The reference commitment is where the venue's fairness argument lives: prices are
///         derived on-chain, after the book is sealed, so the matcher can only prove it used
///         what was committed — it can never assert a price of its own.
contract PriceCommitterTest is Test {
    EligibleRegistry registry;
    EventCalendar calendar;
    PriceCommitter pricer;

    MockStockToken nvda;
    MockStockToken aapl;
    MockAggregatorV3 nvdaFeed;
    MockAggregatorV3 aaplFeed;

    uint16 nvdaId;
    uint16 aaplId;

    address constant USDG = address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    uint32 constant STALENESS = 1 hours;

    function setUp() public {
        vm.warp(1_789_000_000);
        registry = new EligibleRegistry(address(this), USDG);
        calendar = new EventCalendar(address(this));
        pricer = new PriceCommitter(address(this), registry, calendar);

        nvda = new MockStockToken();
        aapl = new MockStockToken();
        nvdaFeed = new MockAggregatorV3();
        aaplFeed = new MockAggregatorV3();
        nvdaFeed.setUpdatedAt(block.timestamp);
        aaplFeed.setUpdatedAt(block.timestamp);
        aaplFeed.setAnswer(33538474720); // $335.38

        nvdaId = registry.registerAsset(
            address(nvda), address(nvdaFeed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
        aaplId = registry.registerAsset(
            address(aapl), address(aaplFeed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );

        // Reach a healthy chain the way production does: a watcher pinging steadily until the
        // post-deploy grace period has elapsed. Jumping the clock in one warp would exceed
        // heartbeatMaxGap and be treated as a fresh outage, resetting the grace each time —
        // which is the contract behaving correctly, not a test inconvenience.
        _runHeartbeatFor(pricer.sequencerGracePeriod() + 1 minutes);

        // Reaching a healthy heartbeat took an hour of simulated time, which left both feeds
        // stale. Refresh them so every test starts from a genuinely healthy baseline and each
        // one only introduces the single fault it is about.
        nvdaFeed.setUpdatedAt(block.timestamp);
        aaplFeed.setUpdatedAt(block.timestamp);

        assertTrue(pricer.sequencerOk(), "setUp should leave the chain healthy");
    }

    /// @dev Advance time in steps shorter than `heartbeatMaxGap`, pinging each step.
    ///      Time is tracked in a local rather than re-read from `block.timestamp` each
    ///      iteration: under `via_ir` the optimiser hoists that read out of the loop, since it
    ///      cannot know `vm.warp` mutates it, and every warp collapses onto the same target.
    function _runHeartbeatFor(uint64 duration) internal {
        uint64 step = pricer.heartbeatMaxGap() / 2;
        uint64 t = uint64(block.timestamp);
        uint64 elapsed = 0;
        while (elapsed < duration) {
            t += step;
            vm.warp(t);
            pricer.heartbeat();
            elapsed += step;
        }
    }

    function _ids() internal view returns (uint16[] memory ids) {
        ids = new uint16[](2);
        ids[0] = nvdaId;
        ids[1] = aaplId;
    }

    // -------------------------------------------------------------------------------------
    // the commitment itself
    // -------------------------------------------------------------------------------------

    function test_CommitsReferencesFromTheFeeds() public {
        (bytes32 root, uint256 mask) = pricer.commitWindow(1, _ids());

        assertTrue(root != bytes32(0), "root must be set");
        assertEq(mask, 0, "nothing should defer on a healthy window");

        PriceCommitter.PriceEntry memory e = pricer.entryOf(1, nvdaId);
        // Chainlink's equity answer prices the token directly; 8 decimals scaled to 1e18.
        assertEq(e.refValueE18, 22244729849 * 1e10, "NVDA reference");
        assertEq(e.uiMultiplierE18, 1_000_775_159_164_630_595, "issuer multiplier is carried, not applied");
        assertEq(e.flags, 0, "no guards");
    }

    /// @dev A window can be priced once. A second call would let the operator re-roll the
    ///      reference after seeing it, which is the exact option this design removes.
    function test_WindowCannotBeRepriced() public {
        pricer.commitWindow(1, _ids());
        vm.expectRevert(abi.encodeWithSelector(PriceCommitter.WindowAlreadyPriced.selector, uint64(1)));
        pricer.commitWindow(1, _ids());
    }

    /// @dev The window id is chained into the header, so a table committed for one window cannot
    ///      be presented as another's.
    function test_RootIsBoundToTheWindowId() public {
        (bytes32 r1,) = pricer.commitWindow(1, _ids());
        (bytes32 r2,) = pricer.commitWindow(2, _ids());
        assertTrue(r1 != r2, "same table, different window, different root");
    }

    function test_RootChangesWithPrice() public {
        (bytes32 before,) = pricer.commitWindow(1, _ids());
        nvdaFeed.setAnswer(30000000000);
        nvdaFeed.setUpdatedAt(block.timestamp);
        (bytes32 afterRoot,) = pricer.commitWindow(2, _ids());
        assertTrue(before != afterRoot, "a different reference must produce a different root");
    }

    function test_RejectsEmptyAndOversizedAssetSets() public {
        uint16[] memory none = new uint16[](0);
        vm.expectRevert(PriceCommitter.NoAssets.selector);
        pricer.commitWindow(1, none);

        uint16[] memory many = new uint16[](33);
        vm.expectRevert(abi.encodeWithSelector(PriceCommitter.TooManyAssets.selector, uint256(33)));
        pricer.commitWindow(2, many);
    }

    // -------------------------------------------------------------------------------------
    // guards — per asset
    // -------------------------------------------------------------------------------------

    /// @dev The spec's core guard property: a deferral isolates one asset and everything else
    ///      keeps crossing.
    function test_StaleAssetDefersAloneWithoutStoppingTheRest() public {
        nvdaFeed.setUpdatedAt(block.timestamp - STALENESS - 1);

        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask, 1, "only slot 0 (NVDA) defers");

        assertTrue(pricer.entryOf(1, nvdaId).flags != 0, "NVDA flagged");
        assertEq(pricer.entryOf(1, aaplId).flags, 0, "AAPL unaffected");
    }

    function test_OraclePausedDefers() public {
        MockStockToken(address(nvda));
        vm.mockCall(address(nvda), abi.encodeWithSignature("oraclePaused()"), abi.encode(true));
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask & 1, 1, "paused oracle defers the asset");
    }

    function test_DelistedAssetDefers() public {
        registry.setAssetStatus(nvdaId, EligibleRegistry.AssetStatus.PAUSED);
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask & 1, 1, "registry status feeds the mask");
    }

    /// @dev Acceptance criterion 3: a window must pause an asset across its ex-date while the
    ///      rest of the book keeps crossing.
    function test_BlackoutDefersAcrossAnExDate() public {
        calendar.scheduleBlackout(
            nvdaId, uint64(block.timestamp - 1 hours), uint64(block.timestamp + 1 hours), calendar.REASON_EX_DATE()
        );
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask, 1, "NVDA deferred by the calendar, AAPL still crossing");
    }

    /// @dev Make a warped chain healthy again: heartbeat past the grace period, then bring the
    ///      feeds to the current block.
    ///
    ///      Warping breaks liveness and freshness at the same time, and a liveness failure is
    ///      pool-wide — it sets FLAG_STALE on every asset, which is the same mask bit a
    ///      multiplier deferral would occupy. Without this a test that warps asserts nothing
    ///      about what it claims to; `test_MultiplierJustActivatedStillDefers` passed on a stale
    ///      heartbeat before this existed.
    ///
    ///      It moves time itself, so call it before staging anything relative to `now`.
    function _restoreLiveness() private {
        pricer.heartbeat();
        _runHeartbeatFor(pricer.sequencerGracePeriod() + 1 minutes);
        nvdaFeed.setUpdatedAt(block.timestamp);
        aaplFeed.setUpdatedAt(block.timestamp);
        require(pricer.sequencerOk(), "liveness not restored");
    }

    /// @dev Stage a multiplier different from the current one, taking effect at `effAt`.
    function _stageMultiplier(uint256 effAt) private {
        vm.mockCall(
            address(nvda), abi.encodeWithSignature("newUIMultiplier()"), abi.encode(uint256(1.5e18))
        );
        vm.mockCall(address(nvda), abi.encodeWithSignature("effectiveAt()"), abi.encode(effAt));
    }

    function test_PendingMultiplierDefers() public {
        _stageMultiplier(block.timestamp + 5 minutes);
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask & 1, 1, "a multiplier about to activate defers the asset");
    }

    /// @dev Just after the restatement is as unreliable as just before it, and a window is
    ///      priced seconds behind the block that activated the change.
    function test_MultiplierJustActivatedStillDefers() public {
        vm.warp(block.timestamp + 1 hours);
        _restoreLiveness();
        _stageMultiplier(block.timestamp - 5 minutes);
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask & 1, 1, "a multiplier that just activated still defers the asset");
    }

    /// @dev The bug that deferred 13 of 35 mainnet assets permanently.
    ///
    /// `effectiveAt` reports the *last* multiplier change, so for any asset that has ever been
    /// restated it is a timestamp in the past. The guard tested only `effAt <= now + window`,
    /// with no lower bound and no check that anything was actually changing — so it matched
    /// forever. AAPL, GOOGL, META, NVDA and SPY never crossed; the assets nobody had restated
    /// did, which is what made it look like ordinary guard behaviour rather than a bug.
    function test_LongPastMultiplierChangeDoesNotDefer() public {
        vm.warp(block.timestamp + 365 days);
        _restoreLiveness();
        // A change that happened two weeks ago, with nothing staged since: current and new are
        // equal, exactly as a real token reports after a restatement completes.
        vm.mockCall(
            address(nvda), abi.encodeWithSignature("effectiveAt()"), abi.encode(block.timestamp - 14 days)
        );
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask & 1, 0, "a completed multiplier change must not defer the asset forever");
    }

    /// @dev `effectiveAt` in the past but no staged change is the common case; so is a staged
    ///      change still far off. Neither is a corporate action in progress.
    function test_StagedChangeFarInTheFutureDoesNotDeferYet() public {
        _stageMultiplier(block.timestamp + 30 days);
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask & 1, 0, "a change a month away is not a window to defer");
    }

    /// @dev An unreadable feed must never become a guessed price.
    function test_UnreadableFeedDefersRatherThanGuessing() public {
        vm.mockCallRevert(address(nvdaFeed), abi.encodeWithSignature("latestRoundData()"), "boom");
        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask & 1, 1, "unreadable feed defers");
        assertEq(pricer.entryOf(1, nvdaId).refValueE18, 0, "no price invented");
    }

    // -------------------------------------------------------------------------------------
    // liveness — pool-wide, not per asset
    // -------------------------------------------------------------------------------------

    /// @dev An outage makes every feed suspect at the same moment, so the defer is pool-wide.
    ///      There is no honest way to keep crossing one asset through it.
    function test_StaleHeartbeatDefersEverything() public {
        vm.warp(block.timestamp + 10 minutes); // past heartbeatMaxGap
        assertFalse(pricer.sequencerOk(), "heartbeat has lapsed");

        (, uint256 mask) = pricer.commitWindow(1, _ids());
        assertEq(mask, 3, "both slots deferred");
    }

    /// @dev Feeds are stale immediately after an outage and catch-up rounds arrive out of order,
    ///      so recovery is not instant.
    function test_GracePeriodAfterRecovery() public {
        // A gap the watcher did not cover: treated as an outage.
        vm.warp(block.timestamp + 10 minutes);
        pricer.heartbeat();
        assertFalse(pricer.sequencerOk(), "still in grace immediately after recovery");

        // Steady pings alone do not clear it — the grace period has to actually elapse.
        _runHeartbeatFor(pricer.sequencerGracePeriod() / 2);
        assertFalse(pricer.sequencerOk(), "grace is a duration, not a formality");

        _runHeartbeatFor(pricer.sequencerGracePeriod());
        assertTrue(pricer.sequencerOk(), "healthy once the grace period has passed");
    }

    // -------------------------------------------------------------------------------------
    // access control
    // -------------------------------------------------------------------------------------

    function test_OnlyPricerMayCommit() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        pricer.commitWindow(1, _ids());
    }

    function test_PreviewNeedsNoRole() public {
        vm.prank(address(0xBEEF));
        PriceCommitter.PriceEntry memory e = pricer.previewEntry(nvdaId);
        assertEq(e.assetId, nvdaId, "the dashboard can read guards without privileges");
    }
}
