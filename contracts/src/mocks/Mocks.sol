// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Test doubles only. Never deployed.

contract MockAggregatorV3 {
    uint8 public decimals = 8;
    int256 public answer = 22244729849; // $222.45, matching a real NVDA round
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    uint256 public updatedAt;

    constructor() {
        updatedAt = block.timestamp;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setAnswer(int256 a) external {
        answer = a;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setRounds(uint80 r, uint80 answered) external {
        roundId = r;
        answeredInRound = answered;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @dev A Robinhood-style tokenized equity: answers the multiplier/oracle group.
contract MockStockToken {
    uint8 public decimals = 18;
    uint256 public uiMultiplier = 1_000_775_159_164_630_595;
    uint256 public newUIMultiplier = 1_000_775_159_164_630_595;
    uint256 public effectiveAt;
    bool public oraclePaused;

    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }
}

/// @dev An ordinary ERC-20 — a crypto asset. Has decimals but none of the stock surface, so the
///      behavioural probe must reject it. This is acceptance criterion 5 in one contract.
contract MockCryptoToken {
    uint8 public decimals = 18;
}

/// @dev The adversarial case: a contract whose fallback swallows every unknown call and returns
///      nothing. A naive `staticcall` success check would treat it as a valid stock token.
contract MockPermissiveFallbackToken {
    uint8 public decimals = 18;

    fallback() external payable {}
    receive() external payable {}
}

/// @dev Worse still: a fallback that returns a well-formed 32-byte word for anything asked.
contract MockLyingFallbackToken {
    // solhint-disable-next-line no-complex-fallback
    fallback() external payable {
        assembly {
            mstore(0, 18)
            return(0, 32)
        }
    }

    receive() external payable {}
}

contract MockNavOracle {
    uint256 public navE18 = 1.0115e18;
    uint256 public asOf;

    constructor() {
        asOf = block.timestamp;
    }

    function setNav(uint256 nav, uint256 t) external {
        navE18 = nav;
        asOf = t;
    }

    function latestNav() external view returns (uint256, uint256) {
        return (navE18, asOf);
    }
}

/// @dev Minimal ERC-20 sufficient for pool tests, plus the Robinhood stock surface so the
///      registry will accept it.
contract MockERC20Stock {
    string public name = "Mock NVDA";
    string public symbol = "NVDA";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Robinhood tokenized-equity surface
    uint256 public uiMultiplier = 1_000_775_159_164_630_595;
    uint256 public newUIMultiplier = 1_000_775_159_164_630_595;
    uint256 public effectiveAt;
    bool public oraclePaused;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    /// @dev The issuer's real power on RHC: destroy tokens held by any address. Used to prove
    ///      the pool detects and reports the resulting shortfall rather than pretending.
    function adminBurn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Takes a cut on every transfer. Must be rejected at deposit: silently crediting the
///      requested amount would break `balanceOf >= totalUnits` from the very first shield.
contract MockFeeOnTransferStock is MockERC20Stock {
    uint256 public feeBps = 100;

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}
