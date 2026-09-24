// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {
    MockAggregatorV3,
    MockCryptoToken,
    MockLyingFallbackToken,
    MockNavOracle,
    MockPermissiveFallbackToken,
    MockStockToken
} from "../src/mocks/Mocks.sol";

/// @notice The registry is the venue's only door. These tests are mostly about what must NOT
///         get through — acceptance criterion 5 ("registry rejects any non-RWA asset") plus the
///         priceability rule that follows from 195 registered assets having only 35 feeds.
contract EligibleRegistryTest is Test {
    EligibleRegistry registry;
    MockStockToken stock;
    MockAggregatorV3 feed;
    MockNavOracle nav;

    address constant USDG = address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address admin = address(this);
    uint32 constant STALENESS = 1 hours;

    function setUp() public {
        // Feeds carry a `updatedAt`; start well clear of zero so staleness maths is meaningful.
        vm.warp(1_789_000_000);
        registry = new EligibleRegistry(admin, USDG);
        stock = new MockStockToken();
        feed = new MockAggregatorV3();
        feed.setUpdatedAt(block.timestamp);
        nav = new MockNavOracle();
    }

    function _registerStock() internal returns (uint16) {
        return registry.registerAsset(
            address(stock), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
    }

    // -------------------------------------------------------------------------------------
    // the happy path
    // -------------------------------------------------------------------------------------

    function test_RegistersATokenizedEquity() public {
        uint16 id = _registerStock();
        EligibleRegistry.Asset memory a = registry.asset(id);
        assertEq(a.token, address(stock));
        assertEq(uint8(a.kind), uint8(EligibleRegistry.AssetKind.STOCK));
        assertEq(uint8(a.status), uint8(EligibleRegistry.AssetStatus.ACTIVE));
        assertEq(a.decimals, 18);
        assertTrue(registry.isActive(address(stock)));
    }

    function test_RejectsDuplicateRegistration() public {
        uint16 id = _registerStock();
        vm.expectRevert(abi.encodeWithSelector(EligibleRegistry.AlreadyRegistered.selector, address(stock), id));
        _registerStock();
    }

    // -------------------------------------------------------------------------------------
    // acceptance criterion 5: no crypto assets, ever
    // -------------------------------------------------------------------------------------

    /// @dev The load-bearing test. A plain ERC-20 has decimals but none of the multiplier/oracle
    ///      surface, so the behavioural probe rejects it. No allowlist required.
    function test_RejectsPlainERC20AsStock() public {
        MockCryptoToken crypto = new MockCryptoToken();
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(crypto), "no uiMultiplier()")
        );
        registry.registerAsset(
            address(crypto), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
    }

    /// @dev A contract whose fallback swallows unknown calls returns success with empty data.
    ///      Checking only `success` would let it masquerade as a stock token.
    function test_RejectsPermissiveFallback() public {
        MockPermissiveFallbackToken sneaky = new MockPermissiveFallbackToken();
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(sneaky), "no uiMultiplier()")
        );
        registry.registerAsset(
            address(sneaky), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
    }

    /// @dev Documents the limit of behavioural probing, deliberately rather than by omission.
    ///      A contract whose fallback returns a well-formed word for every call satisfies every
    ///      shape check here. It cannot be caught on-chain: a beacon proxy's beacon lives in a
    ///      storage slot no other contract can read, and its codehash is shared by every
    ///      Robinhood token, so neither distinguishes a genuine listing from a convincing
    ///      imitation.
    ///
    ///      The probe is therefore defence-in-depth against *registrar error* — a wrong address,
    ///      a crypto token pasted into the wrong field — and not a defence against a malicious
    ///      registrar, who has strictly worse options available anyway. Eligibility ultimately
    ///      rests on the registrar being timelocked governance that verified the address against
    ///      the RHC registry off-chain. Saying so is better than implying a guarantee the code
    ///      does not provide.
    function test_LyingFallbackIsNotStoppedByShapeAlone() public {
        MockLyingFallbackToken liar = new MockLyingFallbackToken();
        uint16 id = registry.registerAsset(
            address(liar), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
        assertTrue(id != 0, "shape probing alone cannot stop a contract that lies consistently");
    }

    function test_RejectsKindNone() public {
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(stock), "kind NONE")
        );
        registry.registerAsset(
            address(stock), address(feed), address(0), EligibleRegistry.AssetKind.NONE, false, STALENESS, 0
        );
    }

    /// @dev "Stablecoin" is not a category here — it is exactly one documented token. Anything
    ///      else claiming the label is a crypto asset by another name.
    function test_OnlyUsdgMayBeStable() public {
        MockCryptoToken impostor = new MockCryptoToken();
        vm.expectRevert(
            abi.encodeWithSelector(
                EligibleRegistry.NotEligibleRWA.selector, address(impostor), "only USDG may be STABLE"
            )
        );
        registry.registerAsset(
            address(impostor), address(feed), address(0), EligibleRegistry.AssetKind.STABLE, false, STALENESS, 0
        );
    }

    // -------------------------------------------------------------------------------------
    // priceability
    // -------------------------------------------------------------------------------------

    /// @dev 195 assets are registered on RHC; only 35 have feeds. Membership is not enough.
    function test_RejectsAssetWithNoFeed() public {
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(stock), "no price feed")
        );
        registry.registerAsset(
            address(stock), address(0), address(0), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
    }

    function test_RejectsFeedWithWrongDecimals() public {
        feed.setDecimals(18);
        vm.expectRevert(
            abi.encodeWithSelector(
                EligibleRegistry.NotEligibleRWA.selector, address(stock), "feed decimals must be 8"
            )
        );
        _registerStock();
    }

    function test_RejectsNonPositiveAnswer() public {
        feed.setAnswer(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                EligibleRegistry.NotEligibleRWA.selector, address(stock), "feed answer not positive"
            )
        );
        _registerStock();
    }

    /// @dev Registering against an already-dead feed would create an entry that can never cross.
    function test_RejectsAlreadyStaleFeed() public {
        feed.setUpdatedAt(block.timestamp - STALENESS - 1);
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(stock), "feed already stale")
        );
        _registerStock();
    }

    function test_RejectsAnswerFromAnOlderRound() public {
        feed.setRounds(9, 7);
        vm.expectRevert(
            abi.encodeWithSelector(
                EligibleRegistry.NotEligibleRWA.selector, address(stock), "feed answer is from an older round"
            )
        );
        _registerStock();
    }

    function test_RejectsZeroStalenessBound() public {
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(stock), "no staleness bound")
        );
        registry.registerAsset(
            address(stock), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, 0, 0
        );
    }

    function test_RejectsZeroMultiplier() public {
        stock.setUiMultiplier(0);
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(stock), "uiMultiplier is zero")
        );
        _registerStock();
    }

    // -------------------------------------------------------------------------------------
    // treasury lane — built, dormant
    // -------------------------------------------------------------------------------------

    function test_TreasuryRequiresNavOracle() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                EligibleRegistry.NotEligibleRWA.selector, address(stock), "treasury needs a NAV oracle"
            )
        );
        registry.registerAsset(
            address(stock), address(feed), address(0), EligibleRegistry.AssetKind.TREASURY, false, STALENESS, 1 days
        );
    }

    function test_TreasuryRejectsStaleNav() public {
        nav.setNav(1.0115e18, block.timestamp - 2 days);
        vm.expectRevert(
            abi.encodeWithSelector(EligibleRegistry.NotEligibleRWA.selector, address(stock), "NAV already stale")
        );
        registry.registerAsset(
            address(stock), address(feed), address(nav), EligibleRegistry.AssetKind.TREASURY, false, STALENESS, 1 days
        );
    }

    function test_TreasuryRegistersWithFreshNav() public {
        uint16 id = registry.registerAsset(
            address(stock), address(feed), address(nav), EligibleRegistry.AssetKind.TREASURY, true, STALENESS, 1 days
        );
        EligibleRegistry.Asset memory a = registry.asset(id);
        assertEq(uint8(a.kind), uint8(EligibleRegistry.AssetKind.TREASURY));
        assertTrue(a.distributing, "BUIDL-class flag drives the rebase adapter");
    }

    /// @dev A NAV oracle on a non-treasury is a configuration mistake, not a harmless extra.
    function test_RejectsNavOracleOnNonTreasury() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                EligibleRegistry.NotEligibleRWA.selector, address(stock), "NAV oracle only for treasuries"
            )
        );
        registry.registerAsset(
            address(stock), address(feed), address(nav), EligibleRegistry.AssetKind.STOCK, false, STALENESS, 0
        );
    }

    // -------------------------------------------------------------------------------------
    // status and access control
    // -------------------------------------------------------------------------------------

    function test_GuardianCanPauseAndResume() public {
        uint16 id = _registerStock();
        registry.setAssetStatus(id, EligibleRegistry.AssetStatus.PAUSED);
        assertFalse(registry.isActive(address(stock)), "paused asset is not active");
        registry.setAssetStatus(id, EligibleRegistry.AssetStatus.ACTIVE);
        assertTrue(registry.isActive(address(stock)));
    }

    /// @dev Delisting is terminal: an asset that was removed for cause must not be quietly
    ///      reinstated by the same key that removed it.
    function test_DelistIsTerminal() public {
        uint16 id = _registerStock();
        registry.setAssetStatus(id, EligibleRegistry.AssetStatus.DELISTED);
        vm.expectRevert(EligibleRegistry.InvalidStatus.selector);
        registry.setAssetStatus(id, EligibleRegistry.AssetStatus.ACTIVE);
    }

    function test_NonRegistrarCannotRegister() public {
        address stranger = address(0xBEEF);
        vm.prank(stranger);
        vm.expectRevert();
        _registerStock();
    }

    function test_NonGuardianCannotChangeStatus() public {
        uint16 id = _registerStock();
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        registry.setAssetStatus(id, EligibleRegistry.AssetStatus.PAUSED);
    }

    function test_UnknownAssetReverts() public {
        vm.expectRevert(abi.encodeWithSelector(EligibleRegistry.UnknownAsset.selector, uint16(99)));
        registry.asset(99);
    }
}
