// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "openzeppelin-contracts/contracts/access/AccessControl.sol";
import {IStockToken} from "./interfaces/IArcLite.sol";

/// @title Corporate-action blackouts
/// @notice Windows must not cross an asset through an ex-date or a multiplier activation: the
///         reference on one side of the event is not comparable to the reference on the other.
///         This holds the per-asset blackout windows that `PriceCommitter` consults.
///
///         `noteMultiplierChange` is deliberately **permissionless**. The token itself announces
///         a staged multiplier via `newUIMultiplier()` / `effectiveAt()`, so anyone — the
///         watcher cron, a trader, a competitor — can force the gate shut around it. Making that
///         a privileged operation would mean the venue's safety depended on our cron being alive.
contract EventCalendar is AccessControl {
    bytes32 public constant CALENDAR_ROLE = keccak256("CALENDAR_ROLE");

    uint8 public constant REASON_EX_DATE = 1;
    uint8 public constant REASON_MULTIPLIER = 2;
    uint8 public constant REASON_NAV_PUBLISH = 3;
    uint8 public constant REASON_MANUAL = 4;

    /// @dev Bounded ring so `isBlackout` stays O(1)-ish; an unbounded list would let anyone make
    ///      the price commit run out of gas by scheduling thousands of blackouts.
    uint256 public constant MAX_BLACKOUTS = 8;

    /// @dev Buffers around a staged multiplier activation. Asymmetric on purpose: the reference
    ///      is unreliable slightly before the switch and needs longer afterwards for the feed to
    ///      catch up to the new multiplier.
    uint64 public constant MULTIPLIER_PRE_BUFFER = 15 minutes;
    uint64 public constant MULTIPLIER_POST_BUFFER = 30 minutes;

    struct Blackout {
        uint64 fromTs;
        uint64 toTs;
        uint8 reason;
    }

    mapping(uint16 => Blackout[MAX_BLACKOUTS]) private _blackouts;
    mapping(uint16 => uint8) private _cursor;

    event BlackoutScheduled(uint16 indexed assetId, uint64 fromTs, uint64 toTs, uint8 reason);
    event BlackoutCleared(uint16 indexed assetId, uint8 slot);

    error BadWindow();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CALENDAR_ROLE, admin);
    }

    function scheduleBlackout(uint16 assetId, uint64 fromTs, uint64 toTs, uint8 reason)
        external
        onlyRole(CALENDAR_ROLE)
    {
        _schedule(assetId, fromTs, toTs, reason);
    }

    /// @notice Force a blackout around a token's staged multiplier activation.
    /// @dev    Permissionless by design — see the contract notice. Reads the announcement from
    ///         the token rather than trusting a caller-supplied timestamp, so an attacker cannot
    ///         use this to blackout an asset arbitrarily.
    function noteMultiplierChange(uint16 assetId, address token) external {
        (bool okNew, bytes memory newData) = token.staticcall(abi.encodeCall(IStockToken.newUIMultiplier, ()));
        (bool okAt, bytes memory atData) = token.staticcall(abi.encodeCall(IStockToken.effectiveAt, ()));
        (bool okCur, bytes memory curData) = token.staticcall(abi.encodeCall(IStockToken.uiMultiplier, ()));
        if (!okNew || !okAt || !okCur || newData.length < 32 || atData.length < 32 || curData.length < 32) {
            revert BadWindow();
        }

        uint256 staged = abi.decode(newData, (uint256));
        uint256 effectiveAt = abi.decode(atData, (uint256));
        uint256 current = abi.decode(curData, (uint256));

        // Nothing staged, or the announcement matches what is already live: no event to gate.
        if (effectiveAt == 0 || staged == 0 || staged == current) revert BadWindow();

        uint64 from = effectiveAt > MULTIPLIER_PRE_BUFFER ? uint64(effectiveAt) - MULTIPLIER_PRE_BUFFER : 0;
        _schedule(assetId, from, uint64(effectiveAt) + MULTIPLIER_POST_BUFFER, REASON_MULTIPLIER);
    }

    function _schedule(uint16 assetId, uint64 fromTs, uint64 toTs, uint8 reason) private {
        if (toTs <= fromTs) revert BadWindow();
        uint8 slot = _cursor[assetId];
        _blackouts[assetId][slot] = Blackout({fromTs: fromTs, toTs: toTs, reason: reason});
        _cursor[assetId] = uint8((slot + 1) % MAX_BLACKOUTS);
        emit BlackoutScheduled(assetId, fromTs, toTs, reason);
    }

    function clearBlackout(uint16 assetId, uint8 slot) external onlyRole(CALENDAR_ROLE) {
        if (slot >= MAX_BLACKOUTS) revert BadWindow();
        delete _blackouts[assetId][slot];
        emit BlackoutCleared(assetId, slot);
    }

    function isBlackout(uint16 assetId, uint64 ts) external view returns (bool) {
        Blackout[MAX_BLACKOUTS] storage b = _blackouts[assetId];
        for (uint256 i = 0; i < MAX_BLACKOUTS; ++i) {
            if (b[i].toTs != 0 && ts >= b[i].fromTs && ts < b[i].toTs) return true;
        }
        return false;
    }

    function blackoutAt(uint16 assetId, uint8 slot) external view returns (Blackout memory) {
        return _blackouts[assetId][slot];
    }
}
