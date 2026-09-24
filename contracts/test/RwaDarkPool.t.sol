// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {EventCalendar} from "../src/EventCalendar.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {MockAggregatorV3, MockERC20Stock, MockFeeOnTransferStock} from "../src/mocks/Mocks.sol";
import {MockVerifier as MV} from "../src/mocks/MockVerifier.sol";

/// @notice The pool holds the funds, so these tests are mostly about what must remain true when
///         everything else has gone wrong: withdrawal stays open, no admin path moves tokens,
///         crossing moves nothing, and a nullifier cannot repeat.
contract RwaDarkPoolTest is Test {
    EligibleRegistry registry;
    EventCalendar calendar;
    PriceCommitter pricer;
    RwaDarkPool pool;
    MockERC20Stock nvda;
    MockAggregatorV3 feed;
    MV shieldV;
    MV unshieldV;
    MV batchV;

    uint16 nvdaId;
    uint16 quoteId;
    address alice = address(0xA11CE);
    address relayer = address(0xBEEF);
    address constant USDG = address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    uint32 constant STALENESS = 1 hours;
    uint128 constant DEPOSIT = 100e18;

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

        // The pool refuses a quote asset the registry does not know, so the fixture registers
        // one. It is a second asset, not the traded one: the crossing proof would refuse a
        // window that priced the asset it also pays out in.
        MockERC20Stock quote = new MockERC20Stock();
        MockAggregatorV3 quoteFeed = new MockAggregatorV3();
        quoteFeed.setUpdatedAt(block.timestamp);
        quoteId = registry.registerAsset(
            address(quote), address(quoteFeed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );

        shieldV = new MV();
        unshieldV = new MV();
        batchV = new MV();
        pool = new RwaDarkPool(address(this), registry, pricer, shieldV, unshieldV, batchV, quoteId);

        nvda.mint(alice, 1_000e18);
        vm.prank(alice);
        nvda.approve(address(pool), type(uint256).max);
    }

    function _shield(uint128 units, bytes32 commitment) internal {
        bytes32[] memory pi = new bytes32[](1);
        pi[0] = commitment;
        vm.prank(alice);
        pool.shield(nvdaId, units, commitment, hex"00", pi, hex"");
    }

    function _unshieldParams(uint128 units, bytes32 nullifier)
        internal
        view
        returns (RwaDarkPool.UnshieldParams memory p)
    {
        p.proof = hex"00";
        p.root = pool.currentRoot();
        p.nullifier = nullifier;
        p.changeCommitment = bytes32(0);
        p.assetId = nvdaId;
        p.units = units;
        p.recipient = alice;
        p.relayerFeeUnits = 0;
        p.relayer = address(0);
        p.ciphertext = hex"";
    }

    // =====================================================================================
    // property 1 — the solvency invariant
    // =====================================================================================

    function test_ShieldBacksEveryUnitItCredits() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        (bool solvent, uint256 owed, uint256 held) = pool.isSolvent(nvdaId);
        assertTrue(solvent);
        assertEq(owed, DEPOSIT, "units credited");
        assertEq(held, DEPOSIT, "tokens actually held");
    }

    /// @dev A fee-on-transfer token would credit more than it delivers, breaking the invariant
    ///      from the very first deposit. Measure the balance delta, never trust the argument.
    function test_RejectsFeeOnTransferToken() public {
        MockFeeOnTransferStock sneaky = new MockFeeOnTransferStock();
        MockAggregatorV3 f2 = new MockAggregatorV3();
        f2.setUpdatedAt(block.timestamp);
        uint16 id = registry.registerAsset(
            address(sneaky), address(f2), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
        sneaky.mint(alice, 1_000e18);
        vm.prank(alice);
        sneaky.approve(address(pool), type(uint256).max);

        bytes32[] memory pi = new bytes32[](1);
        pi[0] = bytes32(uint256(1));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RwaDarkPool.TransferAmountMismatch.selector, uint256(DEPOSIT), uint256(99e18))
        );
        pool.shield(id, DEPOSIT, bytes32(uint256(1)), hex"00", pi, hex"");
    }

    /// @dev The issuer can destroy tokens the pool holds via adminBurn. The pool cannot prevent
    ///      that; it must detect and report it rather than pretending to be solvent.
    function test_DetectsIssuerBurnShortfall() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        nvda.adminBurn(address(pool), 40e18);

        (bool solvent, uint256 owed, uint256 held) = pool.isSolvent(nvdaId);
        assertFalse(solvent, "issuer burn creates a real shortfall");
        assertEq(owed, DEPOSIT);
        assertEq(held, 60e18);

        vm.expectEmit(true, false, false, true, address(pool));
        emit RwaDarkPool.SolvencyShortfall(nvdaId, DEPOSIT, 60e18);
        pool.reportSolvency(nvdaId);
    }

    /// @dev Anyone may raise the alarm — a shortfall nobody can report is a shortfall nobody
    ///      learns about.
    function test_SolvencyReportIsPermissionless() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        vm.prank(address(0xDEAD));
        assertTrue(pool.reportSolvency(nvdaId));
    }

    // =====================================================================================
    // property 2 — unshield is always open
    // =====================================================================================

    /// @dev The headline invariant. Everything that can be turned off, is: the pool is paused,
    ///      the asset is delisted, the feed is dead and the sequencer heartbeat has lapsed.
    ///      Funds must still come out.
    function test_UnshieldWorksWithEverythingElseShutDown() public {
        _shield(DEPOSIT, bytes32(uint256(1)));

        pool.pause();
        registry.setAssetStatus(nvdaId, EligibleRegistry.AssetStatus.DELISTED);
        feed.setUpdatedAt(1); // ancient
        vm.warp(block.timestamp + 30 days); // heartbeat long gone

        uint256 before = nvda.balanceOf(alice);
        pool.unshield(_unshieldParams(DEPOSIT, bytes32(uint256(0x111))));
        assertEq(nvda.balanceOf(alice) - before, DEPOSIT, "withdrawal must not depend on our liveness");
    }

    /// @dev "Always open" means callable by anyone with a proof, not just by the owner — that is
    ///      what makes self-relay from a fresh address possible if the operator censors.
    function test_UnshieldIsCallableByAStranger() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        uint256 before = nvda.balanceOf(alice);
        vm.prank(address(0xC0FFEE));
        pool.unshield(_unshieldParams(DEPOSIT, bytes32(uint256(0x112))));
        assertEq(nvda.balanceOf(alice) - before, DEPOSIT, "recipient is fixed by the proof, not the caller");
    }

    function test_RelayerFeeSplitsCorrectly() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        RwaDarkPool.UnshieldParams memory p = _unshieldParams(DEPOSIT, bytes32(uint256(0x113)));
        p.relayer = relayer;
        p.relayerFeeUnits = 1e18;

        uint256 aliceBefore = nvda.balanceOf(alice);
        vm.prank(relayer);
        pool.unshield(p);
        assertEq(nvda.balanceOf(alice) - aliceBefore, DEPOSIT - 1e18, "recipient net of fee");
        assertEq(nvda.balanceOf(relayer), 1e18, "relayer fee");
    }

    function test_RelayerCannotTakeMoreThanTheWithdrawal() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        RwaDarkPool.UnshieldParams memory p = _unshieldParams(DEPOSIT, bytes32(uint256(0x114)));
        p.relayer = relayer;
        p.relayerFeeUnits = DEPOSIT + 1;
        vm.expectRevert();
        pool.unshield(p);
    }

    function test_NullifierCannotBeReused() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        bytes32 n = bytes32(uint256(0x115));
        pool.unshield(_unshieldParams(50e18, n));
        // Build the params before arming expectRevert: _unshieldParams reads currentRoot(),
        // and that external call would consume the expectation instead of unshield.
        RwaDarkPool.UnshieldParams memory replay = _unshieldParams(10e18, n);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.NullifierAlreadySpent.selector, n));
        pool.unshield(replay);
    }

    function test_UnknownRootRejected() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        RwaDarkPool.UnshieldParams memory p = _unshieldParams(DEPOSIT, bytes32(uint256(0x116)));
        p.root = bytes32(uint256(0xBADBAD));
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.UnknownRoot.selector, p.root));
        pool.unshield(p);
    }

    function test_InvalidProofRejected() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        RwaDarkPool.UnshieldParams memory p = _unshieldParams(DEPOSIT, bytes32(uint256(0x117)));
        unshieldV.setShouldVerify(false);
        vm.expectRevert(RwaDarkPool.InvalidProof.selector);
        pool.unshield(p);
    }

    /// @dev A withdrawal can never exceed what the pool records for that asset, whatever a proof
    ///      claims — the accounting is a second line of defence behind the circuit.
    function test_CannotWithdrawMoreThanPoolHolds() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        RwaDarkPool.UnshieldParams memory p = _unshieldParams(DEPOSIT + 1, bytes32(uint256(0x118)));
        vm.expectRevert(
            abi.encodeWithSelector(
                RwaDarkPool.InsufficientPoolUnits.selector, nvdaId, uint256(DEPOSIT), uint256(DEPOSIT) + 1
            )
        );
        pool.unshield(p);
    }

    // =====================================================================================
    // property 3 — no admin path moves user tokens
    // =====================================================================================

    /// @dev Enumerates the entire governance surface. If a rescue or sweep is ever added, this
    ///      test is where the argument for it has to be made.
    function test_GovernanceCannotMoveTokensOrRewriteState() public {
        _shield(DEPOSIT, bytes32(uint256(1)));
        uint256 held = nvda.balanceOf(address(pool));
        uint256 owed = pool.totalUnits(nvdaId);

        pool.pause();
        pool.unpause();
        // The entry and crossing gates may be zeroed — that stops a gate, which is recoverable,
        // and is how screening is currently disabled on purpose. The exit gate may not: zeroing
        // it would not pause anything, it would let anyone withdraw anyone's notes unproven.
        pool.setVerifiers(IVerifier(address(0)), pool.unshieldVerifier(), IVerifier(address(0)));
        registry.setAssetStatus(nvdaId, EligibleRegistry.AssetStatus.PAUSED);

        assertEq(nvda.balanceOf(address(pool)), held, "no governance action moved a token");
        assertEq(pool.totalUnits(nvdaId), owed, "no governance action changed the accounting");
    }

    /// @dev Withdrawal verification used to be skipped when the verifier was the zero address,
    ///      and the setter accepted zero. One governance call turned a proof-gated exit into an
    ///      unproven one, and nothing about the pool would have looked wrong while it drained.
    function test_GovernanceCannotDisableWithdrawalProofs() public {
        vm.expectRevert(RwaDarkPool.WithdrawalVerifierRequired.selector);
        pool.setVerifiers(shieldV, IVerifier(address(0)), batchV);
    }

    /// @dev The same mistake with a different shape: an EOA, or an address a character wrong, is
    ///      not zero. It would revert every honest withdrawal instead of skipping the proof, so
    ///      it fails loudly here rather than quietly later.
    function test_WithdrawalVerifierMustBeAContract() public {
        address notAContract = address(0xBEEF);
        vm.expectRevert(
            abi.encodeWithSelector(RwaDarkPool.VerifierHasNoCode.selector, notAContract)
        );
        pool.setVerifiers(shieldV, IVerifier(notAContract), batchV);
    }

    function test_ShieldIsPausableButUnshieldIsNot() public {
        pool.pause();
        bytes32[] memory pi = new bytes32[](1);
        pi[0] = bytes32(uint256(2));
        vm.prank(alice);
        vm.expectRevert();
        pool.shield(nvdaId, DEPOSIT, bytes32(uint256(2)), hex"00", pi, hex"");
    }

    function test_ShieldRejectsInactiveAsset() public {
        registry.setAssetStatus(nvdaId, EligibleRegistry.AssetStatus.PAUSED);
        bytes32[] memory pi = new bytes32[](1);
        pi[0] = bytes32(uint256(3));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RwaDarkPool.AssetNotActive.selector, nvdaId));
        pool.shield(nvdaId, DEPOSIT, bytes32(uint256(3)), hex"00", pi, hex"");
    }

    function test_NonGuardianCannotPause() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        pool.pause();
    }
}
