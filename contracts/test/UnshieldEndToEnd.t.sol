// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EligibleRegistry} from "../src/EligibleRegistry.sol";
import {EventCalendar} from "../src/EventCalendar.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {MockAggregatorV3, MockERC20Stock} from "../src/mocks/Mocks.sol";
import {MockVerifier} from "../src/mocks/MockVerifier.sol";
import {HonkVerifier} from "../src/verifiers/UnshieldVerifier.sol";

/// @title A real withdrawal, end to end
/// @notice The whole path with nothing mocked on the proving side: a Noir circuit's real proof,
///         the real generated Honk verifier, the real pool, and a real ERC-20 transfer.
///
///         Everything below is pinned to the same witness. The commitment is the one
///         `circuits/fixture` emits and `src/lib/notes/__tests__/note.test.ts` asserts, so the
///         client SDK, the circuit, the tree and this contract are all demonstrably building the
///         same note — and the pool's tree root after a single deposit is exactly the root the
///         proof was constructed against, which is only true if `CommitmentTree` and
///         `arclite::merkle` agree.
contract UnshieldEndToEndTest is Test {
    EligibleRegistry registry;
    EventCalendar calendar;
    PriceCommitter pricer;
    RwaDarkPool pool;
    MockERC20Stock token;
    MockAggregatorV3 feed;
    HonkVerifier realVerifier;

    uint16 assetId;
    address alice = address(0xA11CE);
    address constant USDG = address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);

    /// The witness the proof was built from: asset_id 1, units 100, recipient 0xaaaa.
    bytes32 constant FIXTURE_COMMITMENT =
        bytes32(0x01b2d87d6f4f966f6da54458e6a259c6463cc714df5ef6baa2edc5794ab6b087);
    bytes32 constant FIXTURE_ROOT =
        bytes32(0x04dfb911529b795d17a1f74fdc6345251508901326a359c3a8fd00abd2f44c27);
    bytes32 constant FIXTURE_NULLIFIER =
        bytes32(0x24926ef182fe58fb14076a863a6ad752093417ab95eb1cf46cb015e0e6c17690);
    uint128 constant FIXTURE_UNITS = 100;
    address constant FIXTURE_RECIPIENT = address(0xaaaa);

    bytes proof;

    function setUp() public {
        vm.warp(1_789_000_000);
        registry = new EligibleRegistry(address(this), USDG);
        calendar = new EventCalendar(address(this));
        pricer = new PriceCommitter(address(this), registry, calendar);

        token = new MockERC20Stock();
        feed = new MockAggregatorV3();
        feed.setUpdatedAt(block.timestamp);
        assetId = registry.registerAsset(
            address(token), address(feed), address(0), EligibleRegistry.AssetKind.STOCK, false, 1 hours, 0
        );
        // The circuit proves `asset_id == 1`, so the registry has to have issued that id. If the
        // numbering ever changes, this fails here rather than as an opaque proof rejection.
        assertEq(assetId, 1, "the fixture proof is bound to assetId 1");

        // The pool refuses a quote asset the registry does not know. Registered after the
        // traded one so `assetId` stays 1, which the fixture proof is bound to.
        MockERC20Stock quote = new MockERC20Stock();
        MockAggregatorV3 quoteFeed = new MockAggregatorV3();
        quoteFeed.setUpdatedAt(block.timestamp);
        uint16 quoteId = registry.registerAsset(
            address(quote), address(quoteFeed), address(0), EligibleRegistry.AssetKind.STOCK, false, 1 hours, 0
        );

        realVerifier = new HonkVerifier();
        pool = new RwaDarkPool(
            address(this),
            registry,
            pricer,
            IVerifier(address(new MockVerifier())), // shield — a separate circuit
            IVerifier(address(realVerifier)), // unshield — the real one
            IVerifier(address(new MockVerifier())), // batch — Phase 4
            quoteId
        );

        proof = vm.readFileBinary("test/fixtures/unshield.proof");

        token.mint(alice, 1_000e18);
        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
    }

    function _deposit() internal {
        bytes32[] memory pi = new bytes32[](1);
        pi[0] = FIXTURE_COMMITMENT;
        vm.prank(alice);
        pool.shield(assetId, FIXTURE_UNITS, FIXTURE_COMMITMENT, hex"00", pi, hex"");
    }

    function _params() internal view returns (RwaDarkPool.UnshieldParams memory p) {
        p.proof = proof;
        p.root = FIXTURE_ROOT;
        p.nullifier = FIXTURE_NULLIFIER;
        p.changeCommitment = bytes32(0);
        p.assetId = assetId;
        p.units = FIXTURE_UNITS;
        p.recipient = FIXTURE_RECIPIENT;
        p.relayerFeeUnits = 0;
        p.relayer = address(0);
        p.ciphertext = hex"";
    }

    /// The contract's tree and the circuit's tree are separate implementations of the same
    /// structure. If they disagreed, every proof would be built against a root the pool has
    /// never held — a deposit that cannot be withdrawn.
    function test_DepositProducesExactlyTheRootTheProofWasBuiltAgainst() public {
        _deposit();
        assertEq(pool.currentRoot(), FIXTURE_ROOT, "contract and circuit disagree on the tree");
    }

    function test_RealProofWithdrawsRealTokens() public {
        _deposit();
        uint256 before = token.balanceOf(FIXTURE_RECIPIENT);

        pool.unshield(_params());

        assertEq(token.balanceOf(FIXTURE_RECIPIENT) - before, FIXTURE_UNITS, "recipient was paid");
        assertEq(pool.totalUnits(assetId), 0, "the pool no longer owes these units");
        assertTrue(pool.nullifierSpent(FIXTURE_NULLIFIER), "the note is spent");
        (bool solvent,,) = pool.isSolvent(assetId);
        assertTrue(solvent, "solvency holds after withdrawal");
    }

    /// Anyone holding a valid proof may broadcast it — that is what makes the self-relay escape
    /// hatch real rather than a promise. The proof names the recipient, so a stranger sending it
    /// cannot redirect the funds.
    function test_AStrangerCanBroadcastAndCannotRedirect() public {
        _deposit();
        vm.prank(address(0xD1FF));
        pool.unshield(_params());
        assertEq(token.balanceOf(FIXTURE_RECIPIENT), FIXTURE_UNITS, "funds went to the proven recipient");
    }

    function test_ReplayIsRejectedByTheNullifierSet() public {
        _deposit();
        pool.unshield(_params());
        vm.expectRevert(
            abi.encodeWithSelector(RwaDarkPool.NullifierAlreadySpent.selector, FIXTURE_NULLIFIER)
        );
        pool.unshield(_params());
    }

    /// The attack the real verifier exists to stop, now exercised through the pool rather than
    /// against the verifier in isolation: a valid proof, resubmitted for more than it proves.
    function test_InflatedUnitsAreRejectedByTheProof() public {
        _deposit();
        // Fund the pool so the units check cannot be what rejects this — the proof must be.
        bytes32[] memory pi = new bytes32[](1);
        pi[0] = keccak256("someone else's note");
        vm.prank(alice);
        pool.shield(assetId, 10_000, keccak256("someone else's note"), hex"00", pi, hex"");

        RwaDarkPool.UnshieldParams memory p = _params();
        p.root = pool.currentRoot();
        p.units = 1_000;
        vm.expectRevert();
        pool.unshield(p);
        assertFalse(pool.nullifierSpent(FIXTURE_NULLIFIER), "a rejected withdrawal must not spend");
    }

    function test_RedirectedRecipientIsRejectedByTheProof() public {
        _deposit();
        RwaDarkPool.UnshieldParams memory p = _params();
        p.recipient = address(0xD1FF);
        vm.expectRevert();
        pool.unshield(p);
        assertEq(token.balanceOf(address(0xD1FF)), 0, "no tokens moved");
    }

    /// The real verifier **reverts** where the mock returns false, so `InvalidProof` is not the
    /// error a caller sees for a bad proof — `SumcheckFailed()` is, raised inside the verifier
    /// before `unshield` can translate it.
    ///
    /// Pinned rather than normalised. A relayer simulates with `eth_call` before spending gas and
    /// stores the revert reason; `SumcheckFailed()` says the proof is cryptographically wrong,
    /// which is strictly more useful than a generic `InvalidProof`. Wrapping the call in
    /// try/catch to force one error would cost gas on the happy path and would also swallow an
    /// out-of-gas as if it were a bad proof. So the behaviour is documented and tested, not
    /// hidden.
    function test_ABadProofSurfacesTheVerifiersOwnError() public {
        _deposit();
        RwaDarkPool.UnshieldParams memory p = _params();
        p.recipient = address(0xD1FF);
        vm.expectRevert(bytes4(keccak256("SumcheckFailed()")));
        pool.unshield(p);
    }

    /// Pause everything pausable, delist the asset, and withdraw anyway. `test_UnshieldAlwaysOpen`
    /// asserts this against the mock; here it holds with a real proof and a real verifier, which
    /// is the version that matters.
    function test_WithdrawalSurvivesAPausedAndDelistedVenue() public {
        _deposit();
        pool.pause();
        registry.setAssetStatus(assetId, EligibleRegistry.AssetStatus.DELISTED);

        pool.unshield(_params());
        assertEq(token.balanceOf(FIXTURE_RECIPIENT), FIXTURE_UNITS, "withdrawal stayed open");
    }
}
