// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink's V3 aggregator surface, as consumed here.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice The Robinhood tokenized-equity surface, verified on mainnet by bytecode dispatcher
///         scan and live calls (docs/week1-check1-transfer-restrictions.md).
/// @dev    `uiMultiplier` is 1e18-scaled shares-per-token. The presence of this whole group is
///         what distinguishes a tokenized equity from an ordinary ERC-20.
interface IStockToken {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function oraclePaused() external view returns (bool);
    function decimals() external view returns (uint8);
}

/// @notice The shared beacon / pause authority / blocklist registry that governs every Robinhood
///         tokenized asset. One `paused()` here freezes all of them at once, and `isBlocked`
///         can halt the pool unilaterally — so both are read, not assumed.
interface ITokenControl {
    function paused() external view returns (bool);
    function isBlocked(address account) external view returns (bool);
}

/// @notice NAV source for treasury-kind assets. Dormant until such an asset exists on RHC.
interface INavOracle {
    /// @return navE18 net asset value per unit, 1e18-scaled
    /// @return asOf  publication timestamp
    function latestNav() external view returns (uint256 navE18, uint256 asOf);
}
