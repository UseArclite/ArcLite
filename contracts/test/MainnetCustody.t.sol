// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface ITokenControl {
    function isBlocked(address) external view returns (bool);
    function paused() external view returns (bool);
}

/// @notice The question that outranks every technical risk in this venue.
///
/// Robinhood's tokenized equities are securities with an issuer behind them, and `TokenControl`
/// holds a blocklist and a global pause covering all 194 of them at once. If those tokens
/// enforce a holder allowlist, or refuse a contract as a recipient, then `RwaDarkPool` cannot
/// hold them and no amount of cryptography matters — the venue does not work, at all, for any
/// asset. `plan.md` called this fatal-if-true and testable in an afternoon, and left it untested
/// because there was nothing on mainnet to test against.
///
/// There is now. This forks Robinhood Chain mainnet and moves real NVDA from a real holder into
/// a real pool, which is the only form of the question that has an answer worth having. It
/// checks three things, and the third is the one that would be found late:
///
///   1. The pool is not on the blocklist and the tokens are not paused.
///   2. A transfer to a pooled contract succeeds at all.
///   3. The **raw** balance credited equals the amount sent. `totalUnits` is raw units and the
///      solvency invariant is `balanceOf(pool) >= totalUnits(asset)`. A token that took a fee,
///      or that credited a multiplier-adjusted amount, would leave the pool insolvent by
///      construction the moment anyone deposited — and these tokens do emit a second,
///      multiplier-adjusted figure alongside the ERC-20 `Transfer`, so "it credited *a* number"
///      is not the same as "it credited the right one".
///
/// Skipped without a mainnet RPC rather than failing, so `forge test` stays offline by default:
///
///   RHC_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc MainnetCustody -vv
contract MainnetCustodyTest is Test {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TOKEN_CONTROL = 0xe10b6f6B275de231345c20D14Ab812db62151b00;

    /// A holder observed moving NVDA on mainnet. Only its balance matters, not its identity.
    address constant HOLDER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /// A stand-in for the pool: what matters is that the recipient is a contract with no
    /// receive hook and no relationship to the issuer, which is exactly the pool's position.
    address recipient;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        // Any contract will do; the registry is one that already exists in this repo and has no
        // token-receiving logic of its own, so nothing about it can flatter the result.
        recipient = address(new EligibleRegistry(address(this), USDG));
    }

    modifier onlyForked() {
        if (bytes(vm.envOr("RHC_MAINNET_RPC", string(""))).length == 0) {
            console.log("skipped: set RHC_MAINNET_RPC to run the mainnet custody check");
            return;
        }
        _;
    }

    function test_TokenControlDoesNotBlockAPooledContract() public onlyForked {
        assertFalse(ITokenControl(TOKEN_CONTROL).isBlocked(recipient), "pool is blocklisted");
        assertFalse(ITokenControl(TOKEN_CONTROL).paused(), "all tokenized assets are paused");
    }

    function test_APooledContractCanHoldTokenizedEquity() public onlyForked {
        IERC20Like nvda = IERC20Like(NVDA);
        uint256 held = nvda.balanceOf(HOLDER);
        if (held < 10e18) {
            // The holder is real and may have moved on. That is a reason to pick another
            // address, not to report that the venue cannot custody its assets.
            console.log("skipped: the reference holder no longer holds 10 NVDA");
            return;
        }

        uint256 before = nvda.balanceOf(recipient);
        vm.prank(HOLDER);
        assertTrue(nvda.transfer(recipient, 10e18), "transfer returned false");

        // Exactly, not approximately. The margin here is the pool's solvency.
        assertEq(nvda.balanceOf(recipient) - before, 10e18, "credited amount is not the amount sent");
    }
}
