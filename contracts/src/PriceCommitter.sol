// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "openzeppelin-contracts/contracts/access/AccessControl.sol";
import {EligibleRegistry} from "./EligibleRegistry.sol";
import {EventCalendar} from "./EventCalendar.sol";
import {Poseidon2} from "./libraries/Poseidon2.sol";
import {IAggregatorV3, INavOracle, IStockToken} from "./interfaces/IArcLite.sol";

/// @title On-chain reference commitment
/// @notice Derives the price table a window crosses against, **in Solidity, from the feeds** —
///         the matcher never asserts a price, it only proves it used what was committed here.
///
///         The ordering is the security argument. `sealWindow` freezes the order set first; only
///         then is `commitWindow` called. If prices were observed before the book closed, the
///         operator would hold a free option: see the reference, then decide which orders to
///         include. Reversing these two calls silently destroys that property, which is why the
///         window id is recorded here and the pool checks it.
///
///         Guards live here too, because a deferral must be part of the same committed artifact
///         as the price it defers. A mask computed elsewhere could disagree with the table.
contract PriceCommitter is AccessControl {
    bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
    bytes32 public constant GOV_ROLE = keccak256("GOV_ROLE");

    /// @dev Domain separator, so a price chain can never be confused with any other Poseidon2
    ///      chain in the system.
    uint256 internal constant DOMAIN_PRICES = uint256(keccak256("arclite.prices.v1")) % Poseidon2.P;

    uint8 internal constant FLAG_STALE = 0x01;
    uint8 internal constant FLAG_PAUSED = 0x02;
    uint8 internal constant FLAG_EVENT = 0x04;
    uint8 internal constant FLAG_NAV_AGED = 0x08;
    uint8 internal constant FLAG_MULTIPLIER_PENDING = 0x10;
    uint8 internal constant FLAG_UNREADABLE = 0x20;

    /// @dev Cap so `deferMask` fits one word and the commit cannot be made to run out of gas.
    uint256 public constant MAX_ASSETS = 32;

    struct PriceEntry {
        uint16 assetId;
        uint8 kind;
        uint8 flags;
        uint64 updatedAt;
        uint80 roundId;
        uint128 refValueE18; // USD per whole token, 1e18-scaled
        uint128 uiMultiplierE18;
    }

    struct WindowPrices {
        bytes32 pricesRoot;
        uint256 deferMask;
        uint64 committedAt;
        uint16 assetCount;
        bool sequencerOk;
    }

    EligibleRegistry public immutable registry;
    EventCalendar public eventCalendar;

    /// @notice Liveness heartbeat.
    /// @dev    Chainlink publishes no L2 Sequencer Uptime Feed for Robinhood Chain and is not
    ///         adding more, so the usual `answer == 0` + grace pattern is unavailable. This shim
    ///         is a weaker, operator-trusted substitute: a watcher pings it, and a gap means the
    ///         chain or the watcher is unhealthy. It is labelled as such rather than dressed up
    ///         as an oracle. Swapping in a real feed later is a setter call.
    uint64 public lastHeartbeat;
    uint64 public heartbeatMaxGap = 180;
    uint64 public sequencerGracePeriod = 1 hours;
    uint64 public recoveredAt;

    /// @dev How far ahead of a staged multiplier activation an asset starts deferring.
    uint64 public multiplierGuardWindow = 15 minutes;

    mapping(uint64 => WindowPrices) private _windows;
    mapping(uint64 => mapping(uint16 => PriceEntry)) private _entries;

    event WindowPriced(
        uint64 indexed windowId, bytes32 pricesRoot, uint256 deferMask, uint64 committedAt, bool sequencerOk
    );
    event Heartbeat(uint64 at);

    error WindowAlreadyPriced(uint64 windowId);
    error TooManyAssets(uint256 count);
    error NoAssets();

    constructor(address admin, EligibleRegistry registry_, EventCalendar calendar_) {
        registry = registry_;
        eventCalendar = calendar_;
        lastHeartbeat = uint64(block.timestamp);
        recoveredAt = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRICER_ROLE, admin);
        _grantRole(GOV_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------------
    // liveness
    // ---------------------------------------------------------------------------------------

    function heartbeat() external onlyRole(PRICER_ROLE) {
        uint64 nowTs = uint64(block.timestamp);
        // Coming back after a gap starts a grace period: feeds are stale immediately after a
        // sequencer outage and catch-up rounds can arrive out of order.
        if (nowTs > lastHeartbeat + heartbeatMaxGap) recoveredAt = nowTs;
        lastHeartbeat = nowTs;
        emit Heartbeat(nowTs);
    }

    function sequencerOk() public view returns (bool) {
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs > lastHeartbeat + heartbeatMaxGap) return false;
        return nowTs >= recoveredAt + sequencerGracePeriod;
    }

    function setHeartbeatParams(uint64 maxGap, uint64 grace) external onlyRole(GOV_ROLE) {
        heartbeatMaxGap = maxGap;
        sequencerGracePeriod = grace;
    }

    function setEventCalendar(EventCalendar calendar_) external onlyRole(GOV_ROLE) {
        eventCalendar = calendar_;
    }

    function setMultiplierGuardWindow(uint64 seconds_) external onlyRole(GOV_ROLE) {
        multiplierGuardWindow = seconds_;
    }

    // ---------------------------------------------------------------------------------------
    // commit
    // ---------------------------------------------------------------------------------------

    /// @notice Read every asset's reference and guard state, and commit them as one artifact.
    /// @dev    Called *after* the order set is sealed. Writes are idempotent-by-refusal: a
    ///         window can be priced once, so a second call cannot re-roll the reference.
    function commitWindow(uint64 windowId, uint16[] calldata assetIds)
        external
        onlyRole(PRICER_ROLE)
        returns (bytes32 pricesRoot, uint256 deferMask)
    {
        if (_windows[windowId].committedAt != 0) revert WindowAlreadyPriced(windowId);
        if (assetIds.length == 0) revert NoAssets();
        if (assetIds.length > MAX_ASSETS) revert TooManyAssets(assetIds.length);

        bool live = sequencerOk();
        uint64 nowTs = uint64(block.timestamp);

        // Chain the header first so a table cannot be replayed under a different window.
        uint256 h = Poseidon2.hash2(DOMAIN_PRICES, uint256(windowId));
        h = Poseidon2.hash2(h, uint256(nowTs));
        h = Poseidon2.hash2(h, live ? 1 : 0);

        for (uint256 i = 0; i < assetIds.length; ++i) {
            PriceEntry memory e = _readAsset(assetIds[i], nowTs);

            // A liveness failure is pool-wide, not per-asset: an outage makes every feed
            // suspect at the same moment, so there is no honest way to keep crossing anything.
            if (!live) e.flags |= FLAG_STALE;

            if (e.flags != 0) deferMask |= (uint256(1) << i);

            _entries[windowId][e.assetId] = e;
            (uint256 lo, uint256 hi) = _pack(e);
            h = Poseidon2.hash2(h, lo);
            h = Poseidon2.hash2(h, hi);
        }

        pricesRoot = bytes32(h);
        _windows[windowId] = WindowPrices({
            pricesRoot: pricesRoot,
            deferMask: deferMask,
            committedAt: nowTs,
            assetCount: uint16(assetIds.length),
            sequencerOk: live
        });

        emit WindowPriced(windowId, pricesRoot, deferMask, nowTs, live);
    }

    function _readAsset(uint16 assetId, uint64 nowTs) private view returns (PriceEntry memory e) {
        EligibleRegistry.Asset memory a = registry.asset(assetId);
        e.assetId = assetId;
        e.kind = uint8(a.kind);
        e.uiMultiplierE18 = uint128(1e18);

        if (a.status != EligibleRegistry.AssetStatus.ACTIVE) e.flags |= FLAG_PAUSED;

        // --- reference ---
        (bool ok, bytes memory data) = a.feed.staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (!ok || data.length < 160) {
            // An unreadable feed is a deferral, never a guessed price.
            e.flags |= FLAG_UNREADABLE | FLAG_STALE;
        } else {
            (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
                abi.decode(data, (uint80, int256, uint256, uint256, uint80));
            e.roundId = roundId;
            e.updatedAt = uint64(updatedAt);

            if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) {
                e.flags |= FLAG_STALE;
            } else if (nowTs > updatedAt + a.maxStalenessSec) {
                // Note: this is a hard ceiling, not the session-aware bound the scheduler
                // applies off-chain. The contract cannot know the NYSE calendar; its job is to
                // refuse genuinely ancient data, while the scheduler declines to open windows
                // when the market is shut.
                e.flags |= FLAG_STALE;
            } else {
                // Chainlink's equity answer already prices the token, not the underlying share,
                // so it is the reference directly. 8 decimals -> 1e18.
                e.refValueE18 = uint128(uint256(answer) * 1e10);
            }
        }

        // --- issuer state ---
        if (a.kind == EligibleRegistry.AssetKind.STOCK) {
            (bool okM, bytes memory mData) = a.token.staticcall(abi.encodeCall(IStockToken.uiMultiplier, ()));
            if (okM && mData.length >= 32) {
                uint256 m = abi.decode(mData, (uint256));
                if (m > 0 && m <= type(uint128).max) e.uiMultiplierE18 = uint128(m);
            }

            (bool okP, bytes memory pData) = a.token.staticcall(abi.encodeCall(IStockToken.oraclePaused, ()));
            if (okP && pData.length >= 32 && abi.decode(pData, (bool))) e.flags |= FLAG_PAUSED;

            // A corporate action is in progress when a *different* multiplier is staged and the
            // moment it takes effect is close. Both halves matter, and the first is what makes
            // the second meaningful.
            //
            // This used to read `effAt != 0 && effAt <= nowTs + multiplierGuardWindow`, which is
            // true for every asset that has ever had a multiplier update: `effectiveAt` reports
            // the *last* change, so it sits in the past and no lower bound ever excluded it. On
            // mainnet that deferred 13 of 35 assets permanently — AAPL, GOOGL, META, NVDA and
            // SPY among them — while the assets nobody had ever restated crossed fine. The
            // off-chain guard in `market.ts` escaped the same mistake only because it also
            // compares `pendingMultiplier` against the current one.
            (bool okN, bytes memory nData) = a.token.staticcall(abi.encodeCall(IStockToken.newUIMultiplier, ()));
            (bool okA, bytes memory aData) = a.token.staticcall(abi.encodeCall(IStockToken.effectiveAt, ()));
            if (okN && okA && nData.length >= 32 && aData.length >= 32) {
                uint256 staged = abi.decode(nData, (uint256));
                uint256 effAt = abi.decode(aData, (uint256));
                bool changing = staged != 0 && staged != e.uiMultiplierE18;
                // A symmetric window: prices are unreliable either side of the restatement,
                // and `effAt` can be a few seconds in the past by the time a window is priced.
                uint256 opensAt = effAt > multiplierGuardWindow ? effAt - multiplierGuardWindow : 0;
                if (changing && effAt != 0 && nowTs >= opensAt && nowTs <= effAt + multiplierGuardWindow) {
                    e.flags |= FLAG_MULTIPLIER_PENDING;
                }
            }
        }

        // --- treasury NAV ---
        if (a.kind == EligibleRegistry.AssetKind.TREASURY && a.navOracle != address(0)) {
            (bool okN, bytes memory nData) = a.navOracle.staticcall(abi.encodeCall(INavOracle.latestNav, ()));
            if (!okN || nData.length < 64) {
                e.flags |= FLAG_NAV_AGED;
            } else {
                (uint256 navE18, uint256 asOf) = abi.decode(nData, (uint256, uint256));
                if (navE18 == 0 || nowTs > asOf + a.maxNavAgeSec) e.flags |= FLAG_NAV_AGED;
                else e.refValueE18 = uint128(navE18);
            }
        }

        // --- corporate actions ---
        if (address(eventCalendar) != address(0) && eventCalendar.isBlackout(assetId, nowTs)) {
            e.flags |= FLAG_EVENT;
        }
    }

    /// @dev Two field elements per entry. Both stay well under the BN254 modulus, so the circuit
    ///      can unpack them without range-check gymnastics.
    function _pack(PriceEntry memory e) internal pure returns (uint256 lo, uint256 hi) {
        lo = uint256(e.assetId) | (uint256(e.kind) << 16) | (uint256(e.flags) << 24)
            | (uint256(e.updatedAt) << 32) | (uint256(e.roundId) << 96);
        hi = uint256(e.refValueE18) | (uint256(e.uiMultiplierE18) << 128);
    }

    // ---------------------------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------------------------

    function window(uint64 windowId) external view returns (WindowPrices memory) {
        return _windows[windowId];
    }

    function entryOf(uint64 windowId, uint16 assetId) external view returns (PriceEntry memory) {
        return _entries[windowId][assetId];
    }

    /// @notice Read an asset's current state without committing, for the dashboard's guards.
    function previewEntry(uint16 assetId) external view returns (PriceEntry memory) {
        return _readAsset(assetId, uint64(block.timestamp));
    }

    function packEntry(PriceEntry memory e) external pure returns (uint256 lo, uint256 hi) {
        return _pack(e);
    }
}
