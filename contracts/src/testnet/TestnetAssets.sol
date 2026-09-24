// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Stand-ins for Robinhood's tokenized equities and their Chainlink feeds.
/// @notice Robinhood Chain testnet has neither: no tokenized equities are deployed there and no
///         Chainlink feeds serve it, so `EligibleRegistry` has nothing it can legitimately
///         accept. These mirror the exact surface the registry probes — `uiMultiplier()`,
///         `newUIMultiplier()`, `effectiveAt()`, `oraclePaused()`, and an 8-decimal
///         `latestRoundData()` — so the venue can be exercised end to end without weakening a
///         single check.
///
/// @dev    **These refuse to exist on mainnet.** A fake asset registered in a venue holding real
///         value is the worst failure this repo could produce, and a deployment script is a
///         thin thing to rely on — one wrong `--rpc-url` is all it takes. The constructor makes
///         it impossible rather than merely discouraged.
abstract contract TestnetOnly {
    error NotOnMainnet(uint256 chainId);

    /// Robinhood Chain mainnet. Also blocked on Ethereum mainnet for the same reason.
    uint256 internal constant RHC_MAINNET = 4663;
    uint256 internal constant ETH_MAINNET = 1;

    constructor() {
        if (block.chainid == RHC_MAINNET || block.chainid == ETH_MAINNET) {
            revert NotOnMainnet(block.chainid);
        }
    }
}

/// @notice An 8-decimal Chainlink-shaped price feed.
/// @dev Decimals are fixed at 8 rather than configurable: the registry rejects anything else, and
///      a feed that could quietly change scale is a way to make every price wrong at once.
contract TestnetPriceFeed is TestnetOnly {
    uint8 public constant decimals = 8;
    string public description;

    int256 public answer;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    uint256 public updatedAt;
    uint256 public startedAt;

    address public immutable owner;

    error NotOwner();
    error NonPositiveAnswer();

    event AnswerUpdated(int256 indexed current, uint80 indexed roundId, uint256 updatedAt);

    constructor(string memory description_, int256 initialAnswer) {
        if (initialAnswer <= 0) revert NonPositiveAnswer();
        description = description_;
        answer = initialAnswer;
        updatedAt = block.timestamp;
        startedAt = block.timestamp;
        owner = msg.sender;
    }

    /// @notice Publish a new round, the way a real aggregator would.
    /// @dev Non-positive answers are rejected here as well as in `PriceCommitter`. A feed that can
    ///      report zero is a feed that can make every position worthless in one transaction, and
    ///      the venue's guard should never be the only thing standing in the way.
    function setAnswer(int256 newAnswer) external {
        if (msg.sender != owner) revert NotOwner();
        if (newAnswer <= 0) revert NonPositiveAnswer();
        answer = newAnswer;
        roundId += 1;
        answeredInRound = roundId;
        updatedAt = block.timestamp;
        startedAt = block.timestamp;
        emit AnswerUpdated(newAnswer, roundId, block.timestamp);
    }

    /// @notice Let the feed go stale deliberately, to exercise the staleness guard on a live chain.
    function setUpdatedAt(uint256 t) external {
        if (msg.sender != owner) revert NotOwner();
        updatedAt = t;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        // A single-round mock: history is not simulated, so the latest round is all there is.
        return (id, answer, startedAt, updatedAt, answeredInRound);
    }
}

/// @notice A tokenized equity with Robinhood's control surface and an open faucet.
/// @dev `mint` is permissionless on purpose. Anyone testing the venue needs tokens to shield, and
///      gating a testnet faucet behind an owner just means asking for tokens. The `TestnetOnly`
///      guard is what makes that safe.
contract TestnetStockToken is TestnetOnly {
    string public name;
    string public symbol;
    /// @dev Not a constant: the venue's quote asset is six decimals while the equities are
    ///      eighteen, and the whole point of the quote leg is that those two are different
    ///      numbers. A stand-in that was 18 decimals on both sides would let a decimal bug
    ///      through unnoticed.
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // The Robinhood tokenized-equity surface the registry probes for. `uiMultiplier` is
    // 1e18-scaled shares per token and drifts upward as the issuer accrues.
    uint256 public uiMultiplier;
    uint256 public newUIMultiplier;
    uint256 public effectiveAt;
    bool public oraclePaused;

    address public immutable owner;

    /// A single mint is capped so one account cannot quietly become the whole float and make
    /// every crossing test meaningless. Scaled by the token's own decimals — a flat 1e24 would
    /// be a million tokens at eighteen decimals and a billion billion at six.
    uint256 public immutable MAX_MINT;

    error NotOwner();
    error MintTooLarge(uint256 requested, uint256 max);
    error InsufficientBalance(address from, uint256 have, uint256 need);
    error InsufficientAllowance(address owner_, address spender, uint256 have, uint256 need);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event UIMultiplierUpdated(uint256 previous, uint256 current, uint256 effectiveAt);

    constructor(string memory name_, string memory symbol_, uint256 uiMultiplier_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        MAX_MINT = 1_000_000 * 10 ** decimals_;
        uiMultiplier = uiMultiplier_;
        newUIMultiplier = uiMultiplier_;
        owner = msg.sender;
    }

    /// @notice Open faucet. Testnet only, by construction.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount, MAX_MINT);
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Schedule a multiplier change, which `EventCalendar.noteMultiplierChange` turns into
    ///         a blackout window — acceptance criterion 3, triggerable on a live chain.
    function scheduleMultiplier(uint256 next, uint256 at) external {
        if (msg.sender != owner) revert NotOwner();
        emit UIMultiplierUpdated(uiMultiplier, next, at);
        newUIMultiplier = next;
        effectiveAt = at;
    }

    /// @notice Apply a scheduled change once its time has come.
    function applyMultiplier() external {
        if (effectiveAt == 0 || block.timestamp < effectiveAt) return;
        uiMultiplier = newUIMultiplier;
        effectiveAt = 0;
    }

    function setOraclePaused(bool paused) external {
        if (msg.sender != owner) revert NotOwner();
        oraclePaused = paused;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(from, msg.sender, allowed, amount);
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        uint256 have = balanceOf[from];
        if (have < amount) revert InsufficientBalance(from, have, amount);
        // Transfers exactly what was asked: no fee, no rebase. The pool rejects fee-on-transfer
        // tokens at deposit, and a testnet token that behaved that way would make every
        // shield fail for a reason unrelated to what was being tested.
        unchecked {
            balanceOf[from] = have - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
