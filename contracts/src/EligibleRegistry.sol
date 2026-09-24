// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "openzeppelin-contracts/contracts/access/AccessControl.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAggregatorV3, INavOracle, IStockToken} from "./interfaces/IArcLite.sol";

/// @title The asset universe gate
/// @notice The only door into the venue. This is where the spec's "no crypto assets, ever"
///         becomes executable: an asset is registrable only if it behaves like a tokenized RWA
///         *and* can be priced. Everything downstream assumes membership here was earned.
///
///         Two discriminators do the real work:
///
///         1. **Behavioural probe.** A Robinhood tokenized equity answers `uiMultiplier()`,
///            `newUIMultiplier()`, `effectiveAt()` and `oraclePaused()`. An ordinary ERC-20 does
///            not, and reverts on the staticcall. That is a cheap, honest test that a symbol
///            allowlist could never be.
///
///         2. **Priceability.** Registry membership is not enough — 195 assets are listed on RHC
///            but only 35 have a Chainlink feed. A venue that cannot derive a guarded reference
///            for an asset has no business crossing it, so a feed is mandatory.
///
///         What the probe does *not* do: it cannot distinguish a genuine Robinhood listing from a
///         contract that imitates the interface convincingly. A beacon proxy's beacon sits in a
///         storage slot no other contract can read, and its codehash is shared across every
///         Robinhood token, so neither is a usable on-chain discriminator. The probe is
///         defence-in-depth against registrar *error*, not against a malicious registrar — who
///         has strictly worse options anyway. Eligibility ultimately rests on timelocked
///         governance having verified the address off-chain.
///
///         Non-upgradeable by construction: no proxy, no delegatecall. The registrar is expected
///         to sit behind a timelock; the guardian is a multisig that can pause or delist
///         instantly. Neither can move funds — pausing an asset blocks new deposits and defers
///         crossing, and never blocks a withdrawal.
contract EligibleRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    enum AssetKind {
        NONE,
        STOCK,
        TREASURY,
        STABLE
    }

    enum AssetStatus {
        UNREGISTERED,
        ACTIVE,
        PAUSED,
        DELISTED
    }

    struct Asset {
        address token;
        address feed;
        address navOracle; // TREASURY only
        AssetKind kind;
        AssetStatus status;
        uint8 decimals;
        bool distributing; // BUIDL-class; drives the rebase adapter
        uint32 maxStalenessSec;
        uint32 maxNavAgeSec; // TREASURY only
        uint16 assetId;
    }

    /// @dev The single permitted STABLE. Hardcoded on purpose: "the fallback quote" is one
    ///      specific token, and leaving it configurable would reopen the door this contract
    ///      exists to close.
    address public immutable usdg;

    mapping(uint16 => Asset) private _assets;
    mapping(address => uint16) public assetIdOf;
    uint16[] private _activeIds;
    uint16 public nextAssetId = 1;

    event AssetRegistered(uint16 indexed assetId, address indexed token, AssetKind kind, address feed);
    event AssetStatusChanged(uint16 indexed assetId, AssetStatus previous, AssetStatus status);

    error NotEligibleRWA(address token, string reason);
    error AlreadyRegistered(address token, uint16 assetId);
    error UnknownAsset(uint16 assetId);
    error InvalidStatus();

    constructor(address admin, address usdg_) {
        if (admin == address(0) || usdg_ == address(0)) revert NotEligibleRWA(address(0), "zero address");
        usdg = usdg_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------------
    // registration
    // ---------------------------------------------------------------------------------------

    function registerAsset(
        address token,
        address feed,
        address navOracle,
        AssetKind kind,
        bool distributing,
        uint32 maxStalenessSec,
        uint32 maxNavAgeSec
    ) external onlyRole(REGISTRAR_ROLE) returns (uint16 assetId) {
        if (token == address(0)) revert NotEligibleRWA(token, "zero token");
        if (assetIdOf[token] != 0) revert AlreadyRegistered(token, assetIdOf[token]);
        if (kind == AssetKind.NONE) revert NotEligibleRWA(token, "kind NONE");

        // STABLE is not a general category — it is exactly one token, the documented fallback
        // quote. Anything else claiming to be a stablecoin is a crypto asset by another name.
        if (kind == AssetKind.STABLE && token != usdg) {
            revert NotEligibleRWA(token, "only USDG may be STABLE");
        }

        uint8 tokenDecimals = _probeDecimals(token);

        if (kind == AssetKind.STOCK) {
            _requireStockBehaviour(token);
        }

        if (kind == AssetKind.TREASURY) {
            if (navOracle == address(0)) revert NotEligibleRWA(token, "treasury needs a NAV oracle");
            if (maxNavAgeSec == 0) revert NotEligibleRWA(token, "treasury needs a NAV age bound");
            (bool ok, uint256 navE18, uint256 asOf) = _probeNav(navOracle);
            if (!ok || navE18 == 0) revert NotEligibleRWA(token, "NAV oracle unreadable");
            if (block.timestamp > asOf + maxNavAgeSec) revert NotEligibleRWA(token, "NAV already stale");
        } else if (navOracle != address(0)) {
            revert NotEligibleRWA(token, "NAV oracle only for treasuries");
        }

        // Priceability, for every kind. Registry membership alone is not enough.
        if (feed == address(0)) revert NotEligibleRWA(token, "no price feed");
        if (maxStalenessSec == 0) revert NotEligibleRWA(token, "no staleness bound");
        _requireLiveFeed(token, feed, maxStalenessSec);

        assetId = nextAssetId++;
        _assets[assetId] = Asset({
            token: token,
            feed: feed,
            navOracle: navOracle,
            kind: kind,
            status: AssetStatus.ACTIVE,
            decimals: tokenDecimals,
            distributing: distributing,
            maxStalenessSec: maxStalenessSec,
            maxNavAgeSec: maxNavAgeSec,
            assetId: assetId
        });
        assetIdOf[token] = assetId;
        _activeIds.push(assetId);

        emit AssetRegistered(assetId, token, kind, feed);
    }

    // ---------------------------------------------------------------------------------------
    // probes
    // ---------------------------------------------------------------------------------------

    /// @dev A staticcall to a missing function reverts on a contract without a fallback, but a
    ///      contract *with* one returns success and empty data. Both must be rejected, or a
    ///      permissive fallback would let anything masquerade as a stock token.
    function _staticProbe(address target, bytes memory call) private view returns (bool ok, bytes memory data) {
        (ok, data) = target.staticcall(call);
        if (ok && data.length < 32) ok = false;
    }

    function _requireStockBehaviour(address token) private view {
        (bool m, bytes memory mData) = _staticProbe(token, abi.encodeCall(IStockToken.uiMultiplier, ()));
        if (!m) revert NotEligibleRWA(token, "no uiMultiplier()");
        if (abi.decode(mData, (uint256)) == 0) revert NotEligibleRWA(token, "uiMultiplier is zero");

        (bool n,) = _staticProbe(token, abi.encodeCall(IStockToken.newUIMultiplier, ()));
        if (!n) revert NotEligibleRWA(token, "no newUIMultiplier()");

        (bool e,) = _staticProbe(token, abi.encodeCall(IStockToken.effectiveAt, ()));
        if (!e) revert NotEligibleRWA(token, "no effectiveAt()");

        (bool p,) = _staticProbe(token, abi.encodeCall(IStockToken.oraclePaused, ()));
        if (!p) revert NotEligibleRWA(token, "no oraclePaused()");
    }

    function _probeDecimals(address token) private view returns (uint8) {
        (bool ok, bytes memory data) = _staticProbe(token, abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!ok) revert NotEligibleRWA(token, "no decimals()");
        uint256 d = abi.decode(data, (uint256));
        if (d > 36) revert NotEligibleRWA(token, "implausible decimals");
        return uint8(d);
    }

    function _probeNav(address navOracle) private view returns (bool ok, uint256 navE18, uint256 asOf) {
        bytes memory data;
        (ok, data) = navOracle.staticcall(abi.encodeCall(INavOracle.latestNav, ()));
        if (!ok || data.length < 64) return (false, 0, 0);
        (navE18, asOf) = abi.decode(data, (uint256, uint256));
        ok = true;
    }

    /// @dev Requires a feed that exists, reports 8 decimals, and is currently answering within
    ///      its staleness bound. Registering an asset whose feed is already dead would create an
    ///      entry that can never cross.
    function _requireLiveFeed(address token, address feed, uint32 maxStalenessSec) private view {
        (bool d, bytes memory dData) = _staticProbe(feed, abi.encodeCall(IAggregatorV3.decimals, ()));
        if (!d) revert NotEligibleRWA(token, "feed has no decimals()");
        if (abi.decode(dData, (uint256)) != 8) revert NotEligibleRWA(token, "feed decimals must be 8");

        (bool r, bytes memory rData) = feed.staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (!r || rData.length < 160) revert NotEligibleRWA(token, "feed has no latestRoundData()");
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            abi.decode(rData, (uint80, int256, uint256, uint256, uint80));
        if (answer <= 0) revert NotEligibleRWA(token, "feed answer not positive");
        if (updatedAt == 0) revert NotEligibleRWA(token, "feed round incomplete");
        if (answeredInRound < roundId) revert NotEligibleRWA(token, "feed answer is from an older round");
        if (block.timestamp > updatedAt + maxStalenessSec) revert NotEligibleRWA(token, "feed already stale");
    }

    // ---------------------------------------------------------------------------------------
    // status
    // ---------------------------------------------------------------------------------------

    /// @notice Pause, resume or delist an asset.
    /// @dev    Guardian-held and deliberately instant: the issuer can pause or blocklist out from
    ///         under us at any time, and waiting out a timelock to react would be worse than the
    ///         centralisation of being able to. Delisting is terminal.
    function setAssetStatus(uint16 assetId, AssetStatus status) external onlyRole(GUARDIAN_ROLE) {
        Asset storage a = _assets[assetId];
        if (a.token == address(0)) revert UnknownAsset(assetId);
        if (status == AssetStatus.UNREGISTERED) revert InvalidStatus();
        if (a.status == AssetStatus.DELISTED) revert InvalidStatus();

        AssetStatus previous = a.status;
        a.status = status;
        emit AssetStatusChanged(assetId, previous, status);
    }

    // ---------------------------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------------------------

    function asset(uint16 assetId) external view returns (Asset memory) {
        Asset memory a = _assets[assetId];
        if (a.token == address(0)) revert UnknownAsset(assetId);
        return a;
    }

    function isActive(address token) external view returns (bool) {
        uint16 id = assetIdOf[token];
        return id != 0 && _assets[id].status == AssetStatus.ACTIVE;
    }

    function registeredCount() external view returns (uint256) {
        return _activeIds.length;
    }

    function assetIdAt(uint256 i) external view returns (uint16) {
        return _activeIds[i];
    }
}
